"""offset（離鍵）の推定精度を掘り下げ、articulation 指標が成立するかを判定する。

note_off_f1 が低かったため、その原因と影響範囲を切り分ける。
articulation は音符の実効長比 DR = 実測長 / 記譜音価 を使う（metrics.md 3.5）。
許容幅は ±0.15〜0.30 なので、DR の推定誤差がこれを超えると指標が成立しない。

ペダル ON 区間では音が繋がって offset の推定が原理的に難しくなるため、
ペダル ON / OFF に分けて誤差を比較する。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi
from scipy.stats import rankdata

ONSET_TOL = 0.05


def notes_of(pm: pretty_midi.PrettyMIDI):
    notes = sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )
    iv = np.array([[n.start, max(n.end, n.start + 1e-3)] for n in notes], dtype=float)
    hz = np.array([pretty_midi.note_number_to_hz(n.pitch) for n in notes], dtype=float)
    return notes, iv, hz


def pedal_intervals(pm: pretty_midi.PrettyMIDI, threshold: int = 64) -> list[tuple[float, float]]:
    events = sorted(
        (c for inst in pm.instruments for c in inst.control_changes if c.number == 64),
        key=lambda c: c.time,
    )
    intervals = []
    start = None
    for cc in events:
        if cc.value >= threshold and start is None:
            start = cc.time
        elif cc.value < threshold and start is not None:
            intervals.append((start, cc.time))
            start = None
    if start is not None:
        intervals.append((start, float("inf")))
    return intervals


def in_pedal(t: float, intervals: list[tuple[float, float]]) -> bool:
    return any(a <= t < b for a, b in intervals)


def overlaps_pedal(start: float, end: float, intervals: list[tuple[float, float]]) -> bool:
    """音符の鳴っている区間にペダル ON が少しでも掛かるか。"""
    return any(a < end and start < b for a, b in intervals)


def analyse(ref_midi: Path, est_midi: Path) -> dict:
    ref = pretty_midi.PrettyMIDI(str(ref_midi))
    est = pretty_midi.PrettyMIDI(str(est_midi))
    r_notes, r_iv, r_hz = notes_of(ref)
    e_notes, e_iv, e_hz = notes_of(est)

    matches = mir_eval.transcription.match_notes(
        r_iv, r_hz, e_iv, e_hz, onset_tolerance=ONSET_TOL, offset_ratio=None
    )
    if not matches:
        return {}

    pedals = pedal_intervals(ref)
    rows = []
    for ri, ei in matches:
        r_dur = r_iv[ri, 1] - r_iv[ri, 0]
        e_dur = e_iv[ei, 1] - e_iv[ei, 0]
        rows.append(
            {
                "ref_dur": r_dur,
                "est_dur": e_dur,
                "offset_err": e_iv[ei, 1] - r_iv[ri, 1],
                "dur_ratio_err": e_dur / r_dur - 1.0,
                "pedal": overlaps_pedal(r_iv[ri, 0], r_iv[ri, 1], pedals),
                "short": r_dur < 0.25,
            }
        )

    arr = {k: np.array([r[k] for r in rows]) for k in rows[0]}

    def stats(mask: np.ndarray) -> dict:
        if mask.sum() < 5:
            return {"n": int(mask.sum())}
        oe = arr["offset_err"][mask]
        de = arr["dur_ratio_err"][mask]
        rd = arr["ref_dur"][mask]
        ed = arr["est_dur"][mask]
        out = {
            "n": int(mask.sum()),
            "offset_mae_ms": round(float(np.abs(oe).mean() * 1000), 1),
            "offset_bias_ms": round(float(oe.mean() * 1000), 1),
            # articulation の許容幅 (±0.15〜0.30) と直接比べられる量
            "dur_ratio_mae": round(float(np.abs(de).mean()), 3),
            "within_0.30": round(float((np.abs(de) <= 0.30).mean()), 3),
        }
        # 系統バイアスがあっても「音符ごとの長短の順序」が保たれていれば
        # 相対評価としての articulation は成立しうる
        if rd.std() > 0 and ed.std() > 0:
            out["dur_pearson"] = round(float(np.corrcoef(rd, ed)[0, 1]), 3)
            out["dur_spearman"] = round(
                float(np.corrcoef(rankdata(rd), rankdata(ed))[0, 1]), 3
            )
            # バイアスを中央値比で補正した後の残差
            scale = float(np.median(ed / rd))
            corrected = ed / scale / rd - 1.0
            out["scale_factor"] = round(scale, 3)
            out["corrected_mae"] = round(float(np.abs(corrected).mean()), 3)
            out["corrected_within_0.30"] = round(float((np.abs(corrected) <= 0.30).mean()), 3)
        return out

    all_mask = np.ones(len(rows), dtype=bool)
    return {
        "all": stats(all_mask),
        "pedal_on": stats(arr["pedal"]),
        "pedal_off": stats(~arr["pedal"]),
        "short_notes": stats(arr["short"]),
        "long_notes": stats(~arr["short"]),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--condition", default="clean")
    ap.add_argument("--out", type=Path, default=Path("out/offset_analysis.json"))
    args = ap.parse_args()

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    per_piece = {}
    for piece in pieces:
        est = args.transcribed / f"{piece['name']}.{args.condition}.mid"
        if not est.exists():
            continue
        per_piece[piece["name"]] = analyse(args.dataset / f"{piece['name']}.ref.mid", est)

    groups = ["all", "pedal_on", "pedal_off", "short_notes", "long_notes"]
    agg = {}
    for g in groups:
        vals = [p[g] for p in per_piece.values() if g in p and p[g].get("n", 0) >= 5]
        if not vals:
            continue
        agg[g] = {
            k: round(float(np.mean([v[k] for v in vals])), 3)
            for k in vals[0]
            if k != "n"
        }
        agg[g]["n"] = int(sum(v["n"] for v in vals))

    print(f"=== offset analysis ({args.condition}) ===")
    for g, s in agg.items():
        print(f"{g:<12} {s}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"condition": args.condition, "aggregate": agg, "per_piece": per_piece},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
