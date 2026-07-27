"""S3: 楽譜アライメント（跳躍付きDTW）。

poc/scripts/align.py の align() をそのまま移植。
弾き直し・部分練習・反復練習への対応は m5-prep-report.md / m45-report.md で
検証済み（JUMP_PENALTY=10.0 で変更不要という結論）。
"""

from __future__ import annotations

import bisect

import numpy as np
import pretty_midi

REF_GROUP_BEATS = 1 / 16
EST_GROUP_SEC = 0.05
STEP_PENALTY = 0.05
JUMP_PENALTY = 10.0


def group_events(items: list[dict], key: str, tol: float) -> list[dict]:
    """近接した音符を1イベントにまとめる。"""
    events: list[dict] = []
    for item in sorted(items, key=lambda x: (x[key], x["pitch"])):
        if events and item[key] - events[-1]["pos"] <= tol:
            events[-1]["members"].append(item)
        else:
            events.append({"pos": item[key], "members": [item]})
    for ev in events:
        mask = 0
        for m in ev["members"]:
            mask |= 1 << int(m["pitch"])
        ev["mask"] = mask
        ev["pos"] = float(np.median([m[key] for m in ev["members"]]))
    return events


def cost_matrix(ref_ev: list[dict], est_ev: list[dict]) -> np.ndarray:
    """イベント間の Jaccard 距離行列。"""
    cost = np.ones((len(ref_ev), len(est_ev)), dtype=np.float32)
    ref_masks = [e["mask"] for e in ref_ev]
    est_masks = [e["mask"] for e in est_ev]
    for i, a in enumerate(ref_masks):
        row = cost[i]
        for j, b in enumerate(est_masks):
            union = (a | b).bit_count()
            if union:
                row[j] = 1.0 - (a & b).bit_count() / union
    return cost


def dtw_path(cost: np.ndarray) -> list[tuple[int, int]]:
    """標準 DTW。斜め以外の遷移にペナルティを課して単調対応を得る。"""
    n, m = cost.shape
    acc = np.full((n + 1, m + 1), np.inf, dtype=np.float64)
    acc[0, 0] = 0.0
    ptr = np.zeros((n, m), dtype=np.int8)
    for i in range(n):
        ci = cost[i]
        acc_prev = acc[i]
        acc_cur = acc[i + 1]
        for j in range(m):
            d = ci[j]
            diag = acc_prev[j]
            up = acc_prev[j + 1] + STEP_PENALTY
            left = acc_cur[j] + STEP_PENALTY
            if diag <= up and diag <= left:
                acc_cur[j + 1] = diag + d
                ptr[i, j] = 0
            elif up <= left:
                acc_cur[j + 1] = up + d
                ptr[i, j] = 1
            else:
                acc_cur[j + 1] = left + d
                ptr[i, j] = 2

    path = []
    i, j = n - 1, m - 1
    while i >= 0 and j >= 0:
        path.append((i, j))
        move = ptr[i, j]
        if move == 0:
            i, j = i - 1, j - 1
        elif move == 1:
            i -= 1
        else:
            j -= 1
    path.reverse()
    return path


def dtw_path_jump(cost: np.ndarray, jump_penalty: float = JUMP_PENALTY) -> list[list[tuple[int, int]]]:
    """楽譜上の任意位置へ跳べる DTW。弾き直し・部分練習に対応する。"""
    n, m = cost.shape
    acc = np.full((n, m), np.inf, dtype=np.float64)
    move = np.zeros((n, m), dtype=np.int8)
    jump_src = np.zeros(m, dtype=np.int32)

    acc[:, 0] = cost[:, 0]
    move[:, 0] = 3
    jump_src[0] = -1

    for j in range(1, m):
        prev = acc[:, j - 1]
        best_prev = int(np.argmin(prev))
        jump_base = prev[best_prev] + jump_penalty
        jump_src[j] = best_prev
        cur = acc[:, j]
        mv = move[:, j]
        cj = cost[:, j]
        run = np.inf
        for i in range(n):
            diag = prev[i - 1] if i else np.inf
            up = run + STEP_PENALTY
            left = prev[i] + STEP_PENALTY
            best, k = diag, 0
            if up < best:
                best, k = up, 1
            if left < best:
                best, k = left, 2
            if jump_base < best:
                best, k = jump_base, 3
            run = best + cj[i]
            cur[i] = run
            mv[i] = k

    i, j = int(np.argmin(acc[:, m - 1])), m - 1
    runs: list[list[tuple[int, int]]] = []
    cur_run: list[tuple[int, int]] = []
    while j >= 0:
        cur_run.append((i, j))
        k = move[i, j]
        if k == 0:
            i, j = i - 1, j - 1
        elif k == 1:
            i -= 1
        elif k == 2:
            j -= 1
        else:
            cur_run.reverse()
            runs.append(cur_run)
            cur_run = []
            i, j = int(jump_src[j]), j - 1
            if i < 0:
                break
    if cur_run:
        cur_run.reverse()
        runs.append(cur_run)
    runs.reverse()
    return runs


def match_within(ref_notes: list[dict], est_notes: list[dict]) -> list[tuple[int, int]]:
    """イベント内で同一ピッチを優先して音符を対応付ける。"""
    pairs = []
    used = set()
    for r in ref_notes:
        for k, e in enumerate(est_notes):
            if k in used:
                continue
            if e["pitch"] == r["pitch"]:
                pairs.append((r["index"], e["index"]))
                used.add(k)
                break
    return pairs


def _match_path(
    path: list[tuple[int, int]],
    ref_ev: list[dict],
    est_ev: list[dict],
    est_pos: list[float],
    window_sec: float,
    used_est: set[int],
) -> list[tuple[int, int]]:
    """単調なパス1本に対して音符レベルの対応を求める。"""
    pairs: list[tuple[int, int]] = []
    used_ref: set[int] = set()
    for i, j in path:
        rn = [n for n in ref_ev[i]["members"] if n["index"] not in used_ref]
        en = [n for n in est_ev[j]["members"] if n["index"] not in used_est]
        for r_idx, e_idx in match_within(rn, en):
            pairs.append((r_idx, e_idx))
            used_ref.add(r_idx)
            used_est.add(e_idx)

    span: dict[int, tuple[int, int]] = {}
    for i, j in path:
        lo, hi = span.get(i, (j, j))
        span[i] = (min(lo, j), max(hi, j))
    j_lo = min(j for _, j in path)
    j_hi = max(j for _, j in path)
    for i in sorted(span):
        rn = [n for n in ref_ev[i]["members"] if n["index"] not in used_ref]
        if not rn:
            continue
        lo, hi = span[i]
        left = max(j_lo, bisect.bisect_left(est_pos, est_pos[lo] - window_sec))
        right = min(j_hi + 1, bisect.bisect_right(est_pos, est_pos[hi] + window_sec))
        predicted = float(np.mean(est_pos[lo : hi + 1]))
        candidates: dict[int, list[tuple[float, int]]] = {}
        for j in range(left, right):
            dist = abs(est_pos[j] - predicted)
            for e in est_ev[j]["members"]:
                if e["index"] in used_est:
                    continue
                candidates.setdefault(e["pitch"], []).append((dist, e["index"]))
        for r in rn:
            cands = candidates.get(r["pitch"])
            if not cands:
                continue
            cands.sort()
            _, e_idx = cands.pop(0)
            pairs.append((r["index"], e_idx))
            used_ref.add(r["index"])
            used_est.add(e_idx)
    return pairs


def align(
    reference: dict,
    est_notes: list[dict],
    window_sec: float = 1.0,
    mode: str = "jump",
    jump_penalty: float = JUMP_PENALTY,
) -> dict:
    ref_notes = reference["notes"]
    ref_ev = group_events(ref_notes, "startBeat", REF_GROUP_BEATS)
    est_ev = group_events(est_notes, "start", EST_GROUP_SEC)
    if not ref_ev or not est_ev:
        return {
            "pairs": [],
            "missed": [n["index"] for n in ref_notes],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }

    cost = cost_matrix(ref_ev, est_ev)
    if mode == "jump":
        runs = dtw_path_jump(cost, jump_penalty)
    else:
        runs = [dtw_path(cost)]

    est_pos = [ev["pos"] for ev in est_ev]
    used_est: set[int] = set()
    final: dict[int, int] = {}
    retakes: list[tuple[int, int]] = []
    covered: set[int] = set()
    for path in runs:
        covered.update(i for i, _ in path)
        for r_idx, e_idx in _match_path(path, ref_ev, est_ev, est_pos, window_sec, used_est):
            if r_idx in final:
                retakes.append((r_idx, final[r_idx]))
            final[r_idx] = e_idx

    covered_notes = {n["index"] for i in covered for n in ref_ev[i]["members"]}
    matched_est = set(final.values())
    retake_est = {e for _, e in retakes}
    return {
        "pairs": sorted(final.items()),
        "missed": [
            n["index"] for n in ref_notes if n["index"] not in final and n["index"] in covered_notes
        ],
        "unplayed": [n["index"] for n in ref_notes if n["index"] not in covered_notes],
        "retakes": sorted(retakes),
        "extra": [
            n["index"]
            for n in est_notes
            if n["index"] not in matched_est and n["index"] not in retake_est
        ],
        "takes": len(runs),
    }


def load_est(path) -> list[dict]:
    pm = pretty_midi.PrettyMIDI(str(path))
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    return [
        {
            "index": i,
            "pitch": int(n.pitch),
            "start": float(n.start),
            "end": float(n.end),
            "velocity": int(n.velocity),
        }
        for i, n in enumerate(notes)
    ]
