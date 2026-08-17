from __future__ import annotations

import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.align import (  # noqa: E402
    NOISE_ONSET_SEC,
    NOISE_SPURIOUS_DURATION_SEC,
    NOISE_SPURIOUS_VELOCITY,
    NOISE_VELOCITY_RATIO,
    classify_extra,
)


def note(index: int, pitch: int, start: float, velocity: int = 80, duration: float = 0.5) -> dict:
    return {
        "index": index,
        "pitch": pitch,
        "start": start,
        "end": start + duration,
        "velocity": velocity,
    }


class ClassifyExtraTest(unittest.TestCase):
    def test_same_pitch_at_the_same_onset_is_a_duplicate_detection(self):
        est = [note(0, 60, 1.000), note(1, 60, 1.020)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraPlayed"], [])
        self.assertEqual(result["extraNoiseByReason"]["duplicate"], 1)

    def test_same_pitch_far_apart_is_a_played_note(self):
        # 同一ピッチでも onset が離れていれば「同じ音をもう一度弾いた」＝弾き間違い。
        est = [note(0, 60, 1.000), note(1, 60, 1.000 + NOISE_ONSET_SEC + 0.001)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])
        self.assertEqual(result["extraNoise"], [])

    def test_weak_octave_at_the_same_onset_is_a_harmonic_ghost(self):
        est = [note(0, 60, 1.000, velocity=80), note(1, 72, 1.010, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["harmonic"], 1)

    def test_loud_octave_at_the_same_onset_is_a_played_note(self):
        # 強い八度は演奏として弾かれたもの。velocity 比だけがゴーストとの境目。
        loud = int(80 * NOISE_VELOCITY_RATIO) + 5
        est = [note(0, 60, 1.000, velocity=80), note(1, 72, 1.010, velocity=loud)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])

    def test_short_and_weak_note_is_spurious(self):
        est = [
            note(0, 60, 1.000),
            note(1, 67, 5.000, velocity=NOISE_SPURIOUS_VELOCITY - 1,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["spurious"], 1)

    def test_short_but_loud_note_is_a_played_note(self):
        est = [
            note(0, 60, 1.000),
            note(1, 67, 5.000, velocity=NOISE_SPURIOUS_VELOCITY,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])

    def test_weak_repeat_inside_a_pedal_span_is_reverb(self):
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 2.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 3.0)])
        self.assertEqual(result["extraNoise"], [1])
        self.assertEqual(result["extraNoiseByReason"]["reverb"], 1)

    def test_weak_repeat_outside_any_pedal_span_is_a_played_note(self):
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 2.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 1.5)])
        self.assertEqual(result["extraPlayed"], [1])

    def test_weak_repeat_in_a_different_pedal_span_is_a_played_note(self):
        # 別のペダル区間の音は残響では説明できない（ペダルが上がって減衰している）。
        est = [note(0, 60, 1.000, velocity=90), note(1, 60, 4.000, velocity=30)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1], est_pedal=[(0.5, 1.5), (3.5, 5.0)])
        self.assertEqual(result["extraPlayed"], [1])

    def test_a_wrong_note_survives_as_played(self):
        # 隣接半音の誤打（フェーズ1 の合格条件3が守るもの）。
        est = [note(0, 60, 1.000), note(1, 61, 1.000)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraPlayed"], [1])
        self.assertEqual(sum(result["extraNoiseByReason"].values()), 0)

    def test_reason_priority_follows_the_design_order(self):
        # 同一ピッチ・同時・短く弱い音は、設計の並び（1→2→3→4）により duplicate。
        est = [
            note(0, 60, 1.000, velocity=90),
            note(1, 60, 1.010, velocity=NOISE_SPURIOUS_VELOCITY - 1,
                 duration=NOISE_SPURIOUS_DURATION_SEC - 0.001),
        ]
        result = classify_extra(est, pairs=[(0, 0)], extra=[1])
        self.assertEqual(result["extraNoiseByReason"]["duplicate"], 1)
        self.assertEqual(result["extraNoiseByReason"]["spurious"], 0)

    def test_no_extra_returns_empty_buckets(self):
        est = [note(0, 60, 1.000)]
        result = classify_extra(est, pairs=[(0, 0)], extra=[])
        self.assertEqual(result["extraNoise"], [])
        self.assertEqual(result["extraPlayed"], [])
        self.assertEqual(sum(result["extraNoiseByReason"].values()), 0)

    def test_unmatched_reference_only_notes_do_not_crash(self):
        # pairs に est 側に存在しない index が入っていても落ちない（防御）。
        est = [note(0, 60, 1.000)]
        result = classify_extra(est, pairs=[(0, 0), (1, 99)], extra=[])
        self.assertEqual(result["extraPlayed"], [])


if __name__ == "__main__":
    unittest.main()
