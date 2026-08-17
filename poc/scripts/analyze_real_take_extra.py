"""実録音1件（脚2）の extra に、align.py の4規則を個別に当てた集計を再現する。

結果文書 §6・§9.3 の詳細値（前段候補数、velocity 比の分布、閾値ごとの発火数、
同音高オンセット対の統計）は `measure_real_take.py` の出力（`extraNoiseByReason` だけ）
からは再現できない、コンテナ内でのアドホック解析の産物だった。本スクリプトはその解析を
コミットされた形で再現する（設計 §9.5 のレビュー指摘への対応）。

`align.py` の `_noise_reason` が実際に分類するのは「閾値を満たした1件」だが、ここでは
「閾値さえ満たせば分類され得た件数（前段候補）」と、各候補がどこまで惜しかったか
（velocity 比）を見るため、閾値判定の手前で候補を集計する。ロジックは worker 側の
`_noise_reason` と同じ探索（onset ±50ms、pitch オクターブ違い、ペダル区間内の先行 matched）
を流用し、式は再実装しない。

入力は measure_real_take.py が書き出す採譜済み MIDI（--reuse-midi 相当）と reference.json。
"""

from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from ledgerlines_worker.align import (  # noqa: E402
    NOISE_ONSET_SEC,
    NOISE_SPURIOUS_DURATION_SEC,
    NOISE_SPURIOUS_VELOCITY,
    NOISE_VELOCITY_RATIO,
    _pedal_span,
    align,
)
from ledgerlines_worker.metrics import load_est  # noqa: E402


def analyze(est_notes, extra, pairs, pedal):
    by_index = {int(n["index"]): n for n in est_notes}
    matched = sorted((by_index[int(e)] for _, e in pairs), key=lambda n: n["start"])
    starts = [n["start"] for n in matched]
    pedal = sorted(pedal or [])

    dup_cand = spurious_dur = spurious_vel = spurious_and = 0
    harmonic_ratios: list[float] = []
    reverb_ratios: list[float] = []

    for e_idx in extra:
        note = by_index[int(e_idx)]
        lo = bisect.bisect_left(starts, note["start"] - NOISE_ONSET_SEC)
        hi = bisect.bisect_right(starts, note["start"] + NOISE_ONSET_SEC)
        near = matched[lo:hi]

        if any(m["pitch"] == note["pitch"] for m in near):
            dup_cand += 1

        octave = [m for m in near if abs(m["pitch"] - note["pitch"]) == 12]
        if octave:
            harmonic_ratios.append(min(note["velocity"] / m["velocity"] for m in octave))

        dur_hit = (note["end"] - note["start"]) < NOISE_SPURIOUS_DURATION_SEC
        vel_hit = note["velocity"] < NOISE_SPURIOUS_VELOCITY
        spurious_dur += dur_hit
        spurious_vel += vel_hit
        spurious_and += dur_hit and vel_hit

        span = _pedal_span(pedal, note["start"])
        if span is not None:
            span_start, _ = span
            cands = [
                m
                for m in matched
                if m["start"] < note["start"] and m["start"] >= span_start and m["pitch"] == note["pitch"]
            ]
            if cands:
                reverb_ratios.append(min(note["velocity"] / m["velocity"] for m in cands))

    def dist(vals):
        if not vals:
            return None
        s = sorted(vals)
        return {
            "min": round(s[0], 4),
            "p10": round(s[max(0, int(len(s) * 0.10) - 1)], 4),
            "median": round(statistics.median(s), 4),
            "max": round(s[-1], 4),
        }

    def sweep(vals, thresholds=(0.60, 0.70, 0.80, 0.90)):
        return {str(t): sum(1 for v in vals if v < t) for t in thresholds}

    # 規則1の裏付け: 採譜 MIDI 全体（matched + extra + retake）での同音高連続オンセット対
    by_pitch: dict[int, list[float]] = {}
    for n in est_notes:
        by_pitch.setdefault(n["pitch"], []).append(n["start"])
    onset_gaps = []
    for starts_p in by_pitch.values():
        starts_p.sort()
        onset_gaps.extend(b - a for a, b in zip(starts_p, starts_p[1:]))

    return {
        "duplicateCandidates": dup_cand,
        "harmonicCandidates": len(harmonic_ratios),
        "harmonicVelocityRatio": dist(harmonic_ratios),
        "harmonicSweep(< threshold)": sweep(harmonic_ratios),
        "spuriousDurationCandidates": spurious_dur,
        "spuriousVelocityCandidates": spurious_vel,
        "spuriousAndFired": spurious_and,
        "reverbCandidates": len(reverb_ratios),
        "reverbVelocityRatio": dist(reverb_ratios),
        "reverbSweep(< threshold)": sweep(reverb_ratios),
        "samePitchOnsetPairs": len(onset_gaps),
        "samePitchOnsetGapMinSec": round(min(onset_gaps), 4) if onset_gaps else None,
        "samePitchOnsetPairsUnder100ms": sum(1 for g in onset_gaps if g < 0.100),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--midi", type=Path, default=Path("out/real-take/transcription.mid"))
    ap.add_argument("--reference", type=Path, required=True)
    args = ap.parse_args()

    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    est_notes, est_pedal = load_est(args.midi)
    alignment = align(reference, est_notes, mode="jump", est_pedal=est_pedal)

    report = analyze(est_notes, alignment["extra"], alignment["pairs"], est_pedal)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
