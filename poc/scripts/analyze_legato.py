"""articulation の代替案（レガート断絶の検出）が成立するかを検証する。

音符長ベースの DR は採譜 offset の系統誤差で成立しないことが分かった。
より粗い判定であれば頑健かもしれない、という仮説を確かめる。

判定するのは 1 ビットだけ:
    「隣り合う音の間に、耳に分かるほどの隙間が空いたか」

隙間 gap = 次の onset - 前の offset。
gap > 0.05 秒なら「切れた」とみなす（metrics.md 3.5 の閾値）。
ref と est でこの判定が一致するかを見る。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi

ONSET_TOL = 0.05
GAP_THRESHOLD = 0.05
PITCH_WINDOW = 12  # 同一声部とみなす音高差の上限（半音）
MAX_IOI = 1.0  # これ以上離れた音は「連続」とみなさない


def notes_of(pm: pretty_midi.PrettyMIDI):
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    iv = np.array([[n.start, max(n.end, n.start + 1e-3)] for n in notes], dtype=float)
    hz = np.array([pretty_midi.note_number_to_hz(n.pitch) for n in notes], dtype=float)
    pitch = np.array([n.pitch for n in notes], dtype=int)
    return notes, iv, hz, pitch


def pedal_intervals(pm: pretty_midi.PrettyMIDI, threshold: int = 64):
    events = sorted(
        (c for inst in pm.instruments for c in inst.control_changes if c.number == 64),
        key=lambda c: c.time,
    )
    intervals, start = [], None
    for cc in events:
        if cc.value >= threshold and start is None:
            start = cc.time
        elif cc.value < threshold and start is not None:
            intervals.append((start, cc.time))
            start = None
    if start is not None:
        intervals.append((start, float("inf")))
    return intervals


def find_successor_pairs(iv: np.ndarray, pitch: np.ndarray) -> list[tuple[int, int]]:
    """同一声部で連続すると推定される音符ペアを拾う。

    厳密な声部分離はしない。「音高が近く、次に鳴る音」を後続とみなす簡易版。
    """
    order = np.argsort(iv[:, 0])
    pairs = []
    for pos, i in enumerate(order):
        best, best_dt = None, None
        for j in order[pos + 1 :]:
            dt = iv[j, 0] - iv[i, 0]
            if dt <= 1e-4:
                continue
            if dt > MAX_IOI:
                break
            if abs(int(pitch[j]) - int(pitch[i])) <= PITCH_WINDOW:
                if best is None or dt < best_dt:
                    best, best_dt = int(j), dt
                break
        if best is not None:
            pairs.append((int(i), best))
    return pairs


def evaluate(ref_midi: Path, est_midi: Path) -> dict:
    ref = pretty_midi.PrettyMIDI(str(ref_midi))
    est = pretty_midi.PrettyMIDI(str(est_midi))
    _, r_iv, r_hz, r_pitch = notes_of(ref)
    _, e_iv, e_hz, e_pitch = notes_of(est)

    matches = mir_eval.transcription.match_notes(
        r_iv, r_hz, e_iv, e_hz, onset_tolerance=ONSET_TOL, offset_ratio=None
    )
    ref_to_est = {int(a): int(b) for a, b in matches}
    pedals = pedal_intervals(ref)

    def under_pedal(a: float, b: float) -> bool:
        return any(x < b and a < y for x, y in pedals)

    rows = []
    for i, j in find_successor_pairs(r_iv, r_pitch):
        if i not in ref_to_est or j not in ref_to_est:
            continue
        ei, ej = ref_to_est[i], ref_to_est[j]
        ref_gap = r_iv[j, 0] - r_iv[i, 1]
        est_gap = e_iv[ej, 0] - e_iv[ei, 1]
        rows.append(
            {
                "ref_detached": bool(ref_gap > GAP_THRESHOLD),
                "est_detached": bool(est_gap > GAP_THRESHOLD),
                "ref_gap": ref_gap,
                "est_gap": est_gap,
                "pedal": under_pedal(r_iv[i, 0], r_iv[j, 0]),
            }
        )

    if not rows:
        return {}

    arr = {k: np.array([r[k] for r in rows]) for k in rows[0]}

    def prf(mask: np.ndarray) -> dict:
        if mask.sum() < 10:
            return {"n": int(mask.sum())}
        ref_d = arr["ref_detached"][mask]
        est_d = arr["est_detached"][mask]
        tp = int(np.sum(ref_d & est_d))
        fp = int(np.sum(~ref_d & est_d))
        fn = int(np.sum(ref_d & ~est_d))
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        return {
            "n": int(mask.sum()),
            "accuracy": round(float((ref_d == est_d).mean()), 3),
            "detach_precision": round(p, 3),
            "detach_recall": round(r, 3),
            "detach_f1": round(2 * p * r / (p + r) if p + r else 0.0, 3),
            "ref_detach_rate": round(float(ref_d.mean()), 3),
            "est_detach_rate": round(float(est_d.mean()), 3),
            "gap_pearson": round(
                float(np.corrcoef(arr["ref_gap"][mask], arr["est_gap"][mask])[0, 1]), 3
            ),
        }

    all_mask = np.ones(len(rows), dtype=bool)
    return {
        "all": prf(all_mask),
        "pedal_on": prf(arr["pedal"]),
        "pedal_off": prf(~arr["pedal"]),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--condition", default="clean")
    ap.add_argument("--out", type=Path, default=Path("out/legato_analysis.json"))
    args = ap.parse_args()

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    per_piece = {}
    for piece in pieces:
        est = args.transcribed / f"{piece['name']}.{args.condition}.mid"
        if est.exists():
            per_piece[piece["name"]] = evaluate(args.dataset / f"{piece['name']}.ref.mid", est)

    agg = {}
    for group in ["all", "pedal_on", "pedal_off"]:
        vals = [p[group] for p in per_piece.values() if group in p and p[group].get("n", 0) >= 10]
        if vals:
            agg[group] = {
                k: round(float(np.mean([v[k] for v in vals])), 3) for k in vals[0] if k != "n"
            }
            agg[group]["n"] = int(sum(v["n"] for v in vals))

    print(f"=== legato detection ({args.condition}) ===")
    for g, s in agg.items():
        print(f"{g:<10} {s}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"condition": args.condition, "aggregate": agg, "per_piece": per_piece},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
