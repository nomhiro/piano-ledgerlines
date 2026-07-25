"""参照譜（拍単位）と採譜結果（秒単位）の音符対応を求める。

analysis-pipeline.md S3 の2段階アライメントを実装する。

Stage 1: 和音をまとめた「イベント列」同士を DTW で対応付ける。
  楽譜と演奏はテンポも表記単位も違うので、まず粗い時間対応を取る。
  距離は同時発音ピッチ集合の Jaccard 距離。和音の部分一致を自然に扱える。

Stage 2: 対応の付いたイベント同士で音符レベルのマッチングを行う。
  同一ピッチを優先し、余ったものを missed / extra とする。

出力は {refIndex, estIndex} のペア列と、未対応音符の一覧。
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


def align(reference: dict, est_notes: list[dict], window_sec: float = 0.5) -> dict:
    ref_notes = reference["notes"]
    ref_ev = group_events(ref_notes, "startBeat", REF_GROUP_BEATS)
    est_ev = group_events(est_notes, "start", EST_GROUP_SEC)
    if not ref_ev or not est_ev:
        return {"pairs": [], "missed": [n["index"] for n in ref_notes], "extra": []}

    path = dtw_path(cost_matrix(ref_ev, est_ev))

    # 同じ ref 音符が複数回対応しないよう、一度使った音符は除外する
    pairs: list[tuple[int, int]] = []
    used_ref: set[int] = set()
    used_est: set[int] = set()
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
    est_pos = [ev["pos"] for ev in est_ev]
    for i, ev in enumerate(ref_ev):
        rn = [n for n in ev["members"] if n["index"] not in used_ref]
        if not rn or i not in span:
            continue
        lo, hi = span[i]
        left = bisect.bisect_left(est_pos, est_pos[lo] - window_sec)
        right = bisect.bisect_right(est_pos, est_pos[hi] + window_sec)
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

    pairs.sort()
    return {
        "pairs": pairs,
        "missed": [n["index"] for n in ref_notes if n["index"] not in used_ref],
        "extra": [n["index"] for n in est_notes if n["index"] not in used_est],
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
    ap.add_argument("--window", type=float, default=0.5, help="近傍探索の窓（秒）")
    ap.add_argument("--pieces", nargs="*", default=None)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
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
            result = align(reference, est, args.window)
            result["name"] = name
            result["condition"] = cond
            (args.out / f"{name}.{cond}.alignment.json").write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8"
            )
            row = {
                "name": name,
                "condition": cond,
                "refNotes": len(reference["notes"]),
                "estNotes": len(est),
                "pairs": len(result["pairs"]),
                "missed": len(result["missed"]),
                "extra": len(result["extra"]),
            }
            summary.append(row)
            print(
                f"{name}/{cond}: ref={row['refNotes']} est={row['estNotes']} "
                f"pairs={row['pairs']} missed={row['missed']} extra={row['extra']}"
            )

    (args.out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
