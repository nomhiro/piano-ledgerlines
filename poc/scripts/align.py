"""参照譜（拍単位）と採譜結果（秒単位）の音符対応を求める。

analysis-pipeline.md S3 の2段階アライメントを実装する。

Stage 1: 和音をまとめた「イベント列」同士を DTW で対応付ける。
  楽譜と演奏はテンポも表記単位も違うので、まず粗い時間対応を取る。
  距離は同時発音ピッチ集合の Jaccard 距離。和音の部分一致を自然に扱える。

  既定の mode=jump では、楽譜上の任意の位置へ跳ぶ遷移を許す。
  練習では数小節戻って弾き直したり、曲の一部だけを弾いたりするため、
  通常の DTW が置く「頭から終わりまで単調に一度だけなぞる」仮定が成り立たない。
  跳躍で区切られた各区間を「テイク」として扱い、同じ音符が複数回弾かれた場合は
  最後のテイクを採点対象とする。

Stage 2: 対応の付いたイベント同士で音符レベルのマッチングを行う。
  同一ピッチを優先し、余ったものを missed / extra とする。

出力は {refIndex, estIndex} のペア列と、未対応音符の一覧。
未対応は「弾かれた範囲での弾き落とし（missed）」と
「そもそも弾いていない範囲（unplayed）」を区別する。
"""

from __future__ import annotations

import argparse
import bisect
import json
from pathlib import Path

import numpy as np
import pretty_midi

# イベントとしてまとめる時間幅（参照譜の格子刻みより細かくする）
REF_GROUP_BEATS = 1 / 16
EST_GROUP_SEC = 0.05
# DTW の非対角遷移に課すペナルティ。過度な伸縮を抑える
STEP_PENALTY = 0.05
# 楽譜上の任意の位置へ跳ぶ遷移に課すペナルティ（mode=jump）
# 小さすぎると採譜ノイズで誤って跳び、大きすぎると弾き直しを追えない。
# 掃引の結果 10.0 で通常演奏の F1 を保ったまま弾き直しに追従できた
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
        # イベントの位置は構成音の中央値に置き直す（外れ値の影響を抑える）
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
    """楽譜上の任意位置へ跳べる DTW。弾き直し・部分練習に対応する。

    通常の DTW は「演奏は楽譜を頭から終わりまで一度だけ単調になぞる」と仮定する。
    練習では数小節戻ってやり直したり、途中の一部だけを弾いたりするので、
    この仮定が破れる。

    そこで遷移に「跳躍」を加える。列 j-1 の最良セルから列 j の任意の行へ、
    固定ペナルティで移動できる。列ごとの最小値を持ち回れば O(N*M) のまま計算できる。
    開始行と終了行も自由にすることで、曲の途中だけを弾いた場合も扱える。

    戻り値は跳躍で区切った単調なパスの列（= テイクの列）。
    """
    n, m = cost.shape
    acc = np.full((n, m), np.inf, dtype=np.float64)
    # move: 0=斜め 1=上(ref進む) 2=左(est進む) 3=跳躍
    move = np.zeros((n, m), dtype=np.int8)
    jump_src = np.zeros(m, dtype=np.int32)

    acc[:, 0] = cost[:, 0]  # 開始位置は自由
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
        run = np.inf  # 直前の行（同じ列）の値 = 上遷移の元
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

    # 終了位置も自由
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

    # 第2パス: DTW パス上のイベント対応だけでは、和音の分散やアルペジオで
    # 音符が隣のイベントにずれた場合を拾えない。パスが示す時刻の近傍まで探す。
    # 窓はイベント数ではなく秒で取る。音符密度が曲や箇所で大きく変わるため。
    span: dict[int, tuple[int, int]] = {}
    for i, j in path:
        lo, hi = span.get(i, (j, j))
        span[i] = (min(lo, j), max(hi, j))
    # 近傍探索がテイクの範囲を越えないよう、パスの est 範囲で頭打ちにする
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
    # テイクごとに対応を求め、同じ参照音符が複数回弾かれたら後のテイクを採用する。
    # 練習では弾き直した最終版を評価するのが自然であるため。
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
        # 前のテイクの音符。弾き間違いではないので extra とは区別する
        "retakes": sorted(retakes),
        "extra": [
            n["index"]
            for n in est_notes
            if n["index"] not in matched_est and n["index"] not in retake_est
        ],
        "takes": len(runs),
    }


def load_est(path: Path) -> list[dict]:
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--out", type=Path, default=Path("out/alignment"))
    ap.add_argument("--conditions", nargs="*", default=["clean", "room", "phone", "phone_agc"])
    ap.add_argument("--window", type=float, default=1.0, help="近傍探索の窓（秒）")
    ap.add_argument("--mode", choices=["strict", "jump"], default="jump")
    ap.add_argument("--jump-penalty", type=float, default=JUMP_PENALTY)
    ap.add_argument("--tag", default="", help="出力ファイル名に付ける識別子")
    ap.add_argument("--pieces", nargs="*", default=None)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    suffix = f".{args.tag}" if args.tag else ""
    summary = []
    for ref_path in sorted(args.reference.glob("*.reference.json")):
        name = ref_path.name.split(".")[0]
        if args.pieces and name not in args.pieces:
            continue
        reference = json.loads(ref_path.read_text(encoding="utf-8"))
        for cond in args.conditions:
            mid = args.transcribed / f"{name}.{cond}.mid"
            if not mid.exists():
                continue
            est = load_est(mid)
            result = align(reference, est, args.window, args.mode, args.jump_penalty)
            result["name"] = name
            result["condition"] = cond
            (args.out / f"{name}.{cond}{suffix}.alignment.json").write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8"
            )
            row = {
                "name": name,
                "condition": cond,
                "refNotes": len(reference["notes"]),
                "estNotes": len(est),
                "pairs": len(result["pairs"]),
                "missed": len(result["missed"]),
                "unplayed": len(result.get("unplayed", [])),
                "retakes": len(result.get("retakes", [])),
                "extra": len(result["extra"]),
                "takes": result.get("takes", 1),
            }
            summary.append(row)
            print(
                f"{name}/{cond}: ref={row['refNotes']} est={row['estNotes']} "
                f"pairs={row['pairs']} missed={row['missed']} unplayed={row['unplayed']} "
                f"retake={row['retakes']} extra={row['extra']} takes={row['takes']}"
            )

    (args.out / f"summary{suffix}.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
