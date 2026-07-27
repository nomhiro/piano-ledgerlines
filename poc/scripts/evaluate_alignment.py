"""アライメントの精度を測る。

正解対応は ground truth MIDI と採譜結果の照合から作る。
  ref 音符 --(gtIndex)--> ground truth 音符 --(mir_eval match)--> 採譜音符
参照譜は ground truth をビート格子にスナップして作ったものなので、
この連鎖が「本来対応すべきペア」になる。

これと align.py の出力を比べ、
  precision = 正しく張れたペア / 張ったペア
  recall    = 正しく張れたペア / 張るべきペア
を求める。誤検出（missed/extra の誤判定）が指標をどれだけ汚すかも見る。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi


def load_notes(path: Path) -> list[pretty_midi.Note]:
    pm = pretty_midi.PrettyMIDI(str(path))
    return sorted(
        (n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch)
    )


def to_arrays(notes: list[pretty_midi.Note]) -> tuple[np.ndarray, np.ndarray]:
    intervals = np.array([[n.start, max(n.end, n.start + 1e-3)] for n in notes], dtype=float)
    pitches = np.array([pretty_midi.note_number_to_hz(n.pitch) for n in notes], dtype=float)
    return intervals, pitches


def truth_pairs(gt: list, est: list, ref_notes: list[dict], tol: float) -> set[tuple[int, int]]:
    gt_i, gt_p = to_arrays(gt)
    est_i, est_p = to_arrays(est)
    matching = mir_eval.transcription.match_notes(
        gt_i, gt_p, est_i, est_p, onset_tolerance=tol, offset_ratio=None
    )
    gt_to_est = dict(matching)
    pairs = set()
    for note in ref_notes:
        est_idx = gt_to_est.get(note["gtIndex"])
        if est_idx is not None:
            pairs.add((note["index"], est_idx))
    return pairs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, default=Path("data/dataset"))
    ap.add_argument("--reference", type=Path, default=Path("out/reference"))
    ap.add_argument("--transcribed", type=Path, default=Path("out/transcribed"))
    ap.add_argument("--alignment", type=Path, default=Path("out/alignment"))
    ap.add_argument("--out", type=Path, default=Path("out/alignment_eval.json"))
    ap.add_argument("--onset-tolerance", type=float, default=0.05)
    args = ap.parse_args()

    rows = []
    for align_path in sorted(args.alignment.glob("*.alignment.json")):
        result = json.loads(align_path.read_text(encoding="utf-8"))
        name, cond = result["name"], result["condition"]
        reference = json.loads(
            (args.reference / f"{name}.reference.json").read_text(encoding="utf-8")
        )
        gt = load_notes(args.dataset / f"{name}.ref.mid")
        est = load_notes(args.transcribed / f"{name}.{cond}.mid")

        truth = truth_pairs(gt, est, reference["notes"], args.onset_tolerance)
        got = {(int(a), int(b)) for a, b in result["pairs"]}
        correct = truth & got

        precision = len(correct) / len(got) if got else 0.0
        recall = len(correct) / len(truth) if truth else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

        # 張るべきなのに張れなかったペアのうち、ref 側を missed と誤判定した割合
        missed_set = set(result["missed"])
        truth_ref = {r for r, _ in truth}
        got_ref = {r for r, _ in got}
        false_missed = len(missed_set & truth_ref) / len(truth_ref) if truth_ref else 0.0
        # 対応があるのに別の est に張ってしまった割合
        correct_ref = {r for r, _ in correct}
        mismatched_ref = (got_ref & truth_ref) - correct_ref
        mismatch_rate = len(mismatched_ref) / len(truth_ref) if truth_ref else 0.0

        # 誤対応の実害を測る。同ピッチの隣接音に張っただけなら指標への影響は小さい
        truth_by_ref = dict(truth)
        got_by_ref = dict(got)
        onset_gaps = []
        same_pitch = 0
        for r in mismatched_ref:
            a, b = est[got_by_ref[r]], est[truth_by_ref[r]]
            onset_gaps.append(abs(a.start - b.start))
            same_pitch += int(a.pitch == b.pitch)
        gap_median = float(np.median(onset_gaps)) if onset_gaps else 0.0
        same_pitch_rate = same_pitch / len(mismatched_ref) if mismatched_ref else 0.0

        rows.append(
            {
                "name": name,
                "condition": cond,
                "truthPairs": len(truth),
                "gotPairs": len(got),
                "correct": len(correct),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
                "falseMissedRate": round(false_missed, 4),
                "mismatchRate": round(mismatch_rate, 4),
                "mismatchOnsetGapMedian": round(gap_median, 4),
                "mismatchSamePitchRate": round(same_pitch_rate, 4),
            }
        )

    by_cond: dict[str, list[dict]] = {}
    for row in rows:
        by_cond.setdefault(row["condition"], []).append(row)

    print(f"{'cond':<10} {'P':>7} {'R':>7} {'F1':>7} {'falseMiss':>10} {'mismatch':>9} {'gapMed':>8} {'samePit':>8}")
    aggregate = {}
    for cond, group in by_cond.items():
        agg = {
            k: round(float(np.mean([g[k] for g in group])), 4)
            for k in (
                "precision",
                "recall",
                "f1",
                "falseMissedRate",
                "mismatchRate",
                "mismatchOnsetGapMedian",
                "mismatchSamePitchRate",
            )
        }
        aggregate[cond] = agg
        print(
            f"{cond:<10} {agg['precision']:>7.4f} {agg['recall']:>7.4f} {agg['f1']:>7.4f} "
            f"{agg['falseMissedRate']:>10.4f} {agg['mismatchRate']:>9.4f} "
            f"{agg['mismatchOnsetGapMedian']:>8.4f} {agg['mismatchSamePitchRate']:>8.4f}"
        )

    args.out.write_text(
        json.dumps({"perPiece": rows, "aggregate": aggregate}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
