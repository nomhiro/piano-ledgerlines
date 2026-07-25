"""採譜結果を ground truth と比較し、指標を支えられる精度かを判定する。

見るもの:
  note_f1        … 音符の検出精度（onset 50ms 許容）。pitch 指標の土台
  note_off_f1    … offset も一致させた精度。articulation 指標の土台
  onset_mae      … onset の時間誤差。rhythm / tempo 指標の分解能を決める
  velocity_r     … velocity の相関。dynamics 指標の土台
  pedal_f1       … sustain pedal 区間の一致。pedal 指標の可否を決める（metrics.md Q2）
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi

ONSET_TOL = 0.05
FRAME = 0.01


def notes_of(pm: pretty_midi.PrettyMIDI):
    notes = [n for inst in pm.instruments for n in inst.notes]
    notes.sort(key=lambda n: (n.start, n.pitch))
    intervals = np.array([[n.start, max(n.end, n.start + 1e-3)] for n in notes], dtype=float)
    pitches = np.array([pretty_midi.note_number_to_hz(n.pitch) for n in notes], dtype=float)
    velocities = np.array([n.velocity for n in notes], dtype=int)
    midi_pitches = np.array([n.pitch for n in notes], dtype=int)
    return intervals, pitches, velocities, midi_pitches


def pedal_frames(pm: pretty_midi.PrettyMIDI, duration: float, threshold: int = 64) -> np.ndarray:
    """CC64 から「踏んでいる/いない」のフレーム列を作る。"""
    n = int(np.ceil(duration / FRAME))
    frames = np.zeros(n, dtype=bool)
    events = sorted(
        (c for inst in pm.instruments for c in inst.control_changes if c.number == 64),
        key=lambda c: c.time,
    )
    if not events:
        return frames
    state = False
    prev_t = 0.0
    for cc in events:
        if state:
            frames[int(prev_t / FRAME) : int(min(cc.time, duration) / FRAME)] = True
        state = cc.value >= threshold
        prev_t = cc.time
    if state:
        frames[int(prev_t / FRAME) :] = True
    return frames


def binary_prf(ref: np.ndarray, est: np.ndarray) -> dict:
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    tp = int(np.sum(ref & est))
    fp = int(np.sum(~ref & est))
    fn = int(np.sum(ref & ~est))
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {
        "precision": round(p, 4),
        "recall": round(r, 4),
        "f1": round(f, 4),
        "ref_on_ratio": round(float(ref.mean()), 4),
        "est_on_ratio": round(float(est.mean()), 4),
    }


def match_notes(ref_iv, ref_p, est_iv, est_p):
    """onset 一致した音符の対応 (ref_idx, est_idx) を返す。"""
    if len(ref_iv) == 0 or len(est_iv) == 0:
        return []
    return mir_eval.transcription.match_notes(
        ref_iv, ref_p, est_iv, est_p, onset_tolerance=ONSET_TOL, offset_ratio=None
    )


def evaluate_pair(ref_midi: Path, est_midi: Path, duration: float) -> dict:
    ref = pretty_midi.PrettyMIDI(str(ref_midi))
    est = pretty_midi.PrettyMIDI(str(est_midi))

    r_iv, r_hz, r_vel, _ = notes_of(ref)
    e_iv, e_hz, e_vel, _ = notes_of(est)

    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        r_iv, r_hz, e_iv, e_hz, onset_tolerance=ONSET_TOL, offset_ratio=None
    )
    po, ro, fo, _ = mir_eval.transcription.precision_recall_f1_overlap(
        r_iv, r_hz, e_iv, e_hz, onset_tolerance=ONSET_TOL, offset_ratio=0.2
    )

    matches = match_notes(r_iv, r_hz, e_iv, e_hz)
    if matches:
        ri = np.array([m[0] for m in matches])
        ei = np.array([m[1] for m in matches])
        onset_err = e_iv[ei, 0] - r_iv[ri, 0]
        rv = r_vel[ri].astype(float)
        ev = e_vel[ei].astype(float)
        vel_r = float(np.corrcoef(rv, ev)[0, 1]) if len(rv) > 2 and rv.std() > 0 else float("nan")
        # velocity は絶対値の一致より「相対的な形」が保たれるかが重要
        rv_z = (rv - rv.mean()) / (rv.std() + 1e-9)
        ev_z = (ev - ev.mean()) / (ev.std() + 1e-9)
        vel_shape_mae = float(np.abs(rv_z - ev_z).mean())
        onset_stats = {
            "onset_mae_ms": round(float(np.abs(onset_err).mean() * 1000), 2),
            "onset_bias_ms": round(float(onset_err.mean() * 1000), 2),
            "onset_p95_ms": round(float(np.percentile(np.abs(onset_err), 95) * 1000), 2),
            "velocity_r": round(vel_r, 4),
            "velocity_shape_mae_sd": round(vel_shape_mae, 4),
            "matched": len(matches),
        }
    else:
        onset_stats = {"matched": 0}

    ped = binary_prf(pedal_frames(ref, duration), pedal_frames(est, duration))

    return {
        "note_f1": round(float(f), 4),
        "note_precision": round(float(p), 4),
        "note_recall": round(float(r), 4),
        "note_off_f1": round(float(fo), 4),
        "ref_notes": int(len(r_iv)),
        "est_notes": int(len(e_iv)),
        **onset_stats,
        "pedal": ped,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--out", type=Path, default=Path("out/eval_transcription.json"))
    args = ap.parse_args()

    pieces = json.loads((args.dataset / "dataset.json").read_text(encoding="utf-8"))
    rows = []
    for piece in pieces:
        ref_midi = args.dataset / f"{piece['name']}.ref.mid"
        for est in sorted(args.transcribed.glob(f"{piece['name']}.*.mid")):
            cond = est.stem.split(".")[-1]
            res = evaluate_pair(ref_midi, est, piece["duration"])
            res.update({"piece": piece["name"], "condition": cond})
            rows.append(res)
            print(
                f"{piece['name']:>8} {cond:<10} noteF1={res['note_f1']:.3f} "
                f"offF1={res['note_off_f1']:.3f} onsetMAE={res.get('onset_mae_ms', float('nan')):6.1f}ms "
                f"velR={res.get('velocity_r', float('nan')):.3f} pedalF1={res['pedal']['f1']:.3f}"
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    by_cond: dict[str, list] = {}
    for row in rows:
        by_cond.setdefault(row["condition"], []).append(row)

    summary = {}
    for cond, group in by_cond.items():
        summary[cond] = {
            "note_f1": round(float(np.mean([g["note_f1"] for g in group])), 4),
            "note_off_f1": round(float(np.mean([g["note_off_f1"] for g in group])), 4),
            "onset_mae_ms": round(float(np.mean([g.get("onset_mae_ms", np.nan) for g in group])), 2),
            "velocity_r": round(float(np.mean([g.get("velocity_r", np.nan) for g in group])), 4),
            "velocity_shape_mae_sd": round(
                float(np.mean([g.get("velocity_shape_mae_sd", np.nan) for g in group])), 4
            ),
            "pedal_f1": round(float(np.mean([g["pedal"]["f1"] for g in group])), 4),
            "n": len(group),
        }

    print("\n=== condition summary ===")
    for cond, s in summary.items():
        print(f"{cond:<10} {s}")

    args.out.write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
