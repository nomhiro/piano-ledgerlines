from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.confidence import apply_fail_closed_policy  # noqa: E402
from ledgerlines_worker.issues import generate_issues  # noqa: E402


class ConfidencePolicyTests(unittest.TestCase):
    def _issue8_case(self):
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "issue8_take_diagnostic.json").read_text(
                encoding="utf-8"
            )
        )
        measure_count = fixture["referenceNotes"] // 12 + 1
        reference = {
            "notes": [
                {"index": index, "measure": index // 12 + 1}
                for index in range(fixture["referenceNotes"])
            ],
            "measures": [
                {"measure": measure, "tempoExcluded": False}
                for measure in range(1, measure_count + 1)
            ],
            "capabilities": {"dynamics": True, "pedal": True},
        }
        alignment = {
            "pairs": [[index, index] for index in range(fixture["matchedNotes"])],
            "missed": list(range(fixture["matchedNotes"], fixture["referenceNotes"])),
            "extra": list(range(fixture["extraNotes"])),
            "retakes": [],
            "unplayed": [],
        }
        raw = fixture["rawScores"]
        result = {
            "overallScore": raw["overallScore"],
            "metrics": dict(raw["metrics"]),
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 12,
                    "score": 40,
                    "metrics": {
                        "pitch": 9.99,
                        "rhythm": 63.3,
                        "tempo": 95.93,
                        "dynamics": 98.58,
                        "pedal": None,
                    },
                }
            ],
        }
        return result, reference, alignment

    def test_issue_8_diagnostic_withholds_pitch_only(self):
        """段2 では pitch だけが保留になり、他4指標は採点される。"""
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result,
            reference,
            alignment,
            1495,
            None,
            dynamic_range_db=18.0,
            pedal_reference_available=False,
        )

        self.assertEqual(guarded["metricEvaluations"]["pitch"]["status"], "withheld")
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "PITCH_FORMULA_UNVALIDATED"
        )
        self.assertEqual(guarded["metricEvaluations"]["rhythm"]["status"], "scored")
        self.assertEqual(guarded["metricEvaluations"]["tempo"]["status"], "scored")
        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["status"], "scored")
        # 参照ペダルが未再生成なので測定対象外
        self.assertEqual(guarded["metricEvaluations"]["pedal"]["status"], "unavailable")
        self.assertEqual(
            guarded["metricEvaluations"]["pedal"]["reasonCode"],
            "PEDAL_REFERENCE_NOT_REGENERATED",
        )
        # rhythm/tempo/dynamics が scored になったことで指摘生成が動くようになる（spec 4.1）
        issues = generate_issues(guarded["measureScores"])
        self.assertTrue(any(issue["metric"] == "rhythm" for issue in issues))

    def test_overall_score_is_withheld_while_pitch_is_unvalidated(self):
        """withheld が1つでも残れば総合点は出さない（spec 4.7）。"""
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=18.0
        )

        self.assertIsNone(guarded["overallScore"])
        self.assertEqual(guarded["evaluation"]["status"], "withheld")

    def test_agc_makes_dynamics_unavailable(self):
        result, reference, alignment = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=7.0
        )

        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["status"], "unavailable")
        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["reasonCode"], "AGC_DETECTED")

    def test_low_match_rate_is_rejected(self):
        """別の曲の音声が来た場合にスコアを出さない安全網。"""
        result, reference, alignment = self._issue8_case()
        alignment["pairs"] = alignment["pairs"][:100]  # matchRate 約 0.08

        guarded = apply_fail_closed_policy(
            result, reference, alignment, 1495, None, dynamic_range_db=18.0
        )

        self.assertTrue(guarded["alignmentBelowFloor"])
        self.assertIsNone(guarded["overallScore"])
        for key in ("pitch", "rhythm", "tempo", "dynamics", "pedal"):
            self.assertIn(
                guarded["metricEvaluations"][key]["status"], {"withheld", "unavailable"}
            )

    def test_alignment_confidence_is_evidence_not_a_release_threshold(self):
        reference = {
            "notes": [
                {"index": 0, "measure": 1},
                {"index": 1, "measure": 1},
                {"index": 2, "measure": 1},
            ]
        }
        alignment = {
            "pairs": [[0, 0], [1, 1], [2, 2]],
            "missed": [],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        result = {
            "overallScore": 100,
            "metrics": {key: 100 for key in ("pitch", "rhythm", "tempo", "dynamics", "pedal")},
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 3,
                    "score": 100,
                    "metrics": {
                        key: 100
                        for key in ("pitch", "rhythm", "tempo", "dynamics", "pedal")
                    },
                }
            ],
        }

        guarded = apply_fail_closed_policy(result, reference, alignment, 3)

        self.assertEqual(guarded["metricConfidence"]["tempo"], 1.0)
        self.assertIsNone(guarded["overallScore"])
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "PITCH_FORMULA_UNVALIDATED"
        )

    def test_approved_data_derived_threshold_can_release_tempo_only(self):
        reference = {
            "notes": [
                {"index": 0, "measure": 1},
                {"index": 1, "measure": 1},
                {"index": 2, "measure": 1},
            ]
        }
        alignment = {
            "pairs": [[0, 0], [1, 1], [2, 2]],
            "missed": [],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        result = {
            "overallScore": 90,
            "metrics": {
                "pitch": 90,
                "rhythm": 90,
                "tempo": 90,
                "dynamics": None,
                "pedal": None,
            },
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 3,
                    "score": 90,
                    "metrics": {
                        "pitch": 90,
                        "rhythm": 90,
                        "tempo": 90,
                        "dynamics": None,
                        "pedal": None,
                    },
                }
            ],
        }
        calibration = {
            "calibrationVersion": "teacher-v1",
            "thresholds": {"tempo": {"minimumConfidence": 0.8}},
        }

        guarded = apply_fail_closed_policy(result, reference, alignment, 3, calibration)

        self.assertEqual(guarded["metricEvaluations"]["tempo"]["status"], "scored")
        self.assertEqual(
            guarded["measureScores"][0]["metricEvaluations"]["tempo"]["status"], "scored"
        )
        self.assertIsNone(guarded["metrics"]["pitch"])
        self.assertIsNone(guarded["overallScore"])

    def test_tempo_calibration_threshold_no_longer_gates_scoring(self):
        """M4 実測で tempo は頑健と判定されたため、較正 artifact の
        thresholds.tempo.minimumConfidence を満たさない（アライメント確信度が低い）
        場合でも tempo は withheld にならない。この閾値はもはや採点のゲートではない
        （較正済み教師評価のための記録としては calibration.py 側にそのまま残る）。
        """
        reference = {
            "notes": [
                {"index": 0, "measure": 1},
                {"index": 1, "measure": 1},
                {"index": 2, "measure": 1},
            ]
        }
        alignment = {
            "pairs": [[0, 0]],
            "missed": [1, 2],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        result = {
            "overallScore": 70,
            "metrics": {"pitch": 50, "rhythm": 50, "tempo": 95, "dynamics": None, "pedal": None},
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 3,
                    "score": 70,
                    "metrics": {
                        "pitch": 50,
                        "rhythm": 50,
                        "tempo": 95,
                        "dynamics": None,
                        "pedal": None,
                    },
                }
            ],
        }
        calibration = {
            "calibrationVersion": "teacher-v1",
            "thresholds": {"tempo": {"minimumConfidence": 0.8}},
        }

        guarded = apply_fail_closed_policy(result, reference, alignment, 1, calibration)

        self.assertEqual(guarded["metricEvaluations"]["tempo"]["status"], "scored")
        self.assertEqual(
            guarded["metricEvaluations"]["tempo"]["reasonCode"], "ROBUSTNESS_VALIDATED"
        )
        self.assertEqual(guarded["metrics"]["tempo"], 95)
        self.assertEqual(guarded["measureScores"][0]["metrics"]["tempo"], 95)


if __name__ == "__main__":
    unittest.main()
