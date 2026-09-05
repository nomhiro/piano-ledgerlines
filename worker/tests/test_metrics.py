from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from ledgerlines_worker.metrics import compute  # noqa: E402


class MetricSemanticsTests(unittest.TestCase):
    def test_explicit_tempo_expression_is_not_scored(self):
        reference = {
            "beatsPerMeasure": 4,
            "notes": [
                {
                    "index": index,
                    "measure": index + 1,
                    "startBeat": index * 4,
                    "pitch": 60,
                    "dynamicLevel": None,
                }
                for index in range(4)
            ],
            "measures": [
                {"measure": 1, "tempoExcluded": False},
                {"measure": 2, "tempoExcluded": True},
                {"measure": 3, "tempoExcluded": False},
                {"measure": 4, "tempoExcluded": False},
            ],
        }
        estimated = [
            {"index": index, "start": start, "pitch": 60, "velocity": 64}
            for index, start in enumerate((0.0, 2.0, 6.0, 8.0))
        ]
        alignment = {
            "pairs": [[index, index] for index in range(4)],
            "missed": [],
            "extra": [],
        }

        result = compute(reference, estimated, alignment, [], [])

        self.assertIsNone(result["measureScores"][1]["metrics"]["tempo"])
        self.assertIsNotNone(result["measureScores"][0]["metrics"]["tempo"])

    def test_degraded_recording_widens_rhythm_dead_zone(self):
        """同じ演奏でも degraded=True なら rhythm のデッドゾーンが広く、点が下がらない。"""
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.04)

        strict = compute(
            reference, est_notes, alignment, est_pedal=[], ref_pedal_beats=[], degraded=False
        )
        lenient = compute(
            reference, est_notes, alignment, est_pedal=[], ref_pedal_beats=[], degraded=True
        )

        self.assertIsNotNone(strict["metrics"]["rhythm"])
        self.assertIsNotNone(lenient["metrics"]["rhythm"])
        self.assertGreater(lenient["metrics"]["rhythm"], strict["metrics"]["rhythm"])

    def test_reference_pedal_is_compared_against_played_pedal(self):
        """参照ペダルと演奏ペダルが一致すれば pedal は高得点になる。"""
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.0)
        reference["capabilities"]["pedal"] = True

        # 拍0〜4にペダル。1拍=1秒なので秒でも 0.0〜4.0。
        result = compute(
            reference,
            est_notes,
            alignment,
            est_pedal=[(0.0, 4.0)],
            ref_pedal_beats=[(0.0, 4.0)],
            degraded=False,
        )

        self.assertIsNotNone(result["metrics"]["pedal"])
        self.assertGreater(result["metrics"]["pedal"], 90.0)

    def test_pedal_penalised_when_player_omits_it(self):
        reference, est_notes, alignment = self._rhythm_fixture(offset_beats=0.0)
        reference["capabilities"]["pedal"] = True

        result = compute(
            reference,
            est_notes,
            alignment,
            est_pedal=[],
            ref_pedal_beats=[(0.0, 4.0)],
            degraded=False,
        )

        self.assertIsNotNone(result["metrics"]["pedal"])
        self.assertLess(result["metrics"]["pedal"], 90.0)

    def _rhythm_fixture(self, offset_beats: float):
        """各拍に2音の和音を置いた参照譜と、そのうち片方だけ遅らせた演奏を返す。

        1拍1音（各 startBeat がちょうど1音だけ）の譜面では、その音自身が
        estimate_beat_map() の拍→秒対応表の唯一のノットになってしまう。
        np.interp() はノット上の点では常に厳密一致するため、sec_to_beat() で
        戻すと必ず元の startBeat にぴったり戻り、どんな offset_beats を入れても
        delta が恒等的に 0 になってしまう（このデッドゾーン切り替えテストが
        最初にこの形で書かれたときはまさにこれで信号が出なかった）。
        和音にして拍ごとに2音を用意し、片方だけ 2*offset_beats 遅らせると、
        その拍の対応表エントリは2音の中央値（= beat + offset_beats）になり、
        対応表全体が offset_beats だけ一律にシフトする。個々の音を逆変換すると
        残差が ±offset_beats に分かれ、全音符の中央値引き算（全体では 0 に戻る）
        でも消えずに残る。ずれ量は 0.03 と 0.045 の間の値（0.04）にする。
        """
        n_beats = 8
        ref_notes = []
        est_notes = []
        for b in range(n_beats):
            for chord_idx, pitch_offset in enumerate((0, 4)):
                index = 2 * b + chord_idx
                ref_notes.append(
                    {
                        "index": index,
                        "pitch": 60 + pitch_offset + (b % 3),
                        "measure": 1,
                        "startBeat": float(b),
                        "dynamicLevel": None,
                    }
                )
                # 和音の1音目はちょうど拍上、2音目は 2*offset_beats 遅れて発音。
                start = float(b) + (2 * offset_beats if chord_idx == 1 else 0.0)
                est_notes.append(
                    {
                        "index": index,
                        "pitch": 60 + pitch_offset + (b % 3),
                        "start": start,
                        "end": start + 0.5,
                        "velocity": 80,
                    }
                )
        reference = {
            "notes": ref_notes,
            "beatsPerMeasure": float(n_beats),
            "measures": [{"measure": 1, "tempoExcluded": False}],
            "capabilities": {"dynamics": False, "pedal": False},
        }
        alignment = {
            "pairs": [[i, i] for i in range(len(ref_notes))],
            "missed": [],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        return reference, est_notes, alignment


class PitchUsesExtraPlayedTest(unittest.TestCase):
    def _fixture(self):
        reference = {
            "notes": [
                {"index": i, "pitch": 60 + i, "measure": 1,
                 "startBeat": float(i), "endBeat": float(i) + 1.0, "dynamicLevel": None}
                for i in range(4)
            ],
            "beatsPerMeasure": 4.0,
            "measures": [{"measure": 1, "tempoExcluded": False}],
            "capabilities": {"dynamics": False, "pedal": False},
        }
        est = [
            {"index": i, "pitch": 60 + i, "start": float(i), "end": float(i) + 0.5, "velocity": 80}
            for i in range(4)
        ] + [
            {"index": 4, "pitch": 60, "start": 0.01, "end": 0.5, "velocity": 80},
        ]
        alignment = {
            "pairs": [[i, i] for i in range(4)],
            "missed": [],
            "unplayed": [],
            "retakes": [],
            "extra": [4],
            "extraNoise": [4],
            "extraPlayed": [],
            "extraNoiseByReason": {"duplicate": 1, "harmonic": 0, "spurious": 0, "reverb": 0},
        }
        return reference, est, alignment

    def test_noise_classified_extra_does_not_lower_pitch(self):
        reference, est, alignment = self._fixture()
        result = compute(reference, est, alignment, [], [])
        self.assertEqual(result["metrics"]["pitch"], 100.0)

    def test_played_extra_lowers_pitch(self):
        reference, est, alignment = self._fixture()
        alignment["extraNoise"] = []
        alignment["extraPlayed"] = [4]
        alignment["extraNoiseByReason"] = {"duplicate": 0, "harmonic": 0, "spurious": 0, "reverb": 0}
        result = compute(reference, est, alignment, [], [])
        self.assertLess(result["metrics"]["pitch"], 100.0)

    def test_alignment_without_the_split_falls_back_to_extra(self):
        # 分類キーが無い古い alignment.json でも採点を落とさない。
        reference, est, alignment = self._fixture()
        for key in ("extraNoise", "extraPlayed", "extraNoiseByReason"):
            alignment.pop(key)
        result = compute(reference, est, alignment, [], [])
        self.assertLess(result["metrics"]["pitch"], 100.0)


class PitchCalibrationTest(unittest.TestCase):
    def _fixture(self, reference_count: int, missed_count: int, extra_count: int):
        matched_count = reference_count - missed_count
        reference = {
            "notes": [
                {
                    "index": index,
                    "pitch": 60 + index % 12,
                    "measure": 1,
                    "startBeat": float(index),
                    "dynamicLevel": None,
                }
                for index in range(reference_count)
            ],
            "beatsPerMeasure": float(reference_count),
            "measures": [{"measure": 1, "tempoExcluded": False}],
            "capabilities": {"dynamics": False, "pedal": False},
        }
        estimated = [
            {
                "index": index,
                "pitch": 60 + index % 12,
                "start": float(index),
                "end": float(index) + 0.5,
                "velocity": 80,
            }
            for index in range(matched_count + extra_count)
        ]
        alignment = {
            "pairs": [[index, index] for index in range(matched_count)],
            "missed": list(range(matched_count, reference_count)),
            "unplayed": [],
            "retakes": [],
            "extra": list(range(matched_count, matched_count + extra_count)),
            "extraNoise": [],
            "extraPlayed": list(range(matched_count, matched_count + extra_count)),
            "extraNoiseByReason": {
                "duplicate": 0,
                "harmonic": 0,
                "spurious": 0,
                "reverb": 0,
            },
        }
        return reference, estimated, alignment

    def _pitch(self, reference_count: int, missed_count: int, extra_count: int) -> float:
        reference, estimated, alignment = self._fixture(
            reference_count, missed_count, extra_count
        )
        result = compute(reference, estimated, alignment, [], [])
        return result["metrics"]["pitch"]

    def test_perfect_performance_scores_100(self):
        self.assertEqual(self._pitch(100, 0, 0), 100.0)

    def test_more_missed_notes_lower_the_score_monotonically(self):
        perfect = self._pitch(100, 0, 0)
        missed_5_percent = self._pitch(100, 5, 0)
        missed_15_percent = self._pitch(100, 15, 0)
        self.assertGreater(perfect, missed_5_percent)
        self.assertGreater(missed_5_percent, missed_15_percent)

    def test_more_extra_notes_lower_the_score_monotonically(self):
        perfect = self._pitch(100, 0, 0)
        extra_5_percent = self._pitch(100, 0, 5)
        extra_15_percent = self._pitch(100, 0, 15)
        self.assertGreater(perfect, extra_5_percent)
        self.assertGreater(extra_5_percent, extra_15_percent)

    def test_summer_like_alignment_scores_in_the_eighties(self):
        # Azure の最新 Summer テイクの匿名化した件数:
        # reference=1242, missed=95, extraPlayed=245。
        score = self._pitch(1242, 95, 245)
        self.assertGreaterEqual(score, 80.0)
        self.assertLess(score, 90.0)

    def test_result_records_pitch_scoring_parameters(self):
        reference, estimated, alignment = self._fixture(100, 5, 5)
        result = compute(reference, estimated, alignment, [], [])
        self.assertEqual(
            result["pitchScoringParameters"],
            {"missWeight": 1.0, "extraWeight": 0.5, "decayTau": 1.0},
        )


if __name__ == "__main__":
    unittest.main()
