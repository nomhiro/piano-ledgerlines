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
    def test_issue_8_diagnostic_is_withheld_without_calibration(self):
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "issue8_take_diagnostic.json").read_text(
                encoding="utf-8"
            )
        )
        reference = {
            "notes": [
                {"index": index, "measure": index // 12 + 1}
                for index in range(fixture["referenceNotes"])
            ]
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
            "metrics": raw["metrics"],
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 12,
                    "score": 40,
                    "metrics": {
                        "pitch": 9.99,
                        "rhythm": 0,
                        "tempo": 95.93,
                        "dynamics": 98.58,
                        "pedal": None,
                    },
                }
            ],
        }

        guarded = apply_fail_closed_policy(
            result, reference, alignment, fixture["transcribedNotes"]
        )

        self.assertIsNone(guarded["overallScore"])
        self.assertIsNone(guarded["metrics"]["pitch"])
        self.assertEqual(guarded["metrics"]["tempo"], 95.93)
        self.assertEqual(
            guarded["evaluation"]["status"], fixture["expected"]["evaluationStatus"]
        )
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["status"],
            fixture["expected"]["pitchStatus"],
        )
        self.assertEqual(
            guarded["metricEvaluations"]["tempo"]["status"],
            fixture["expected"]["tempoStatus"],
        )
        self.assertEqual(guarded["diagnostics"]["referenceNotes"], 1242)
        self.assertEqual(guarded["diagnostics"]["transcribedNotes"], 1495)
        self.assertEqual(guarded["diagnostics"]["matchedNotes"], 974)
        self.assertEqual(guarded["diagnostics"]["extraNotes"], 521)
        self.assertNotIn("rawScores", guarded)
        self.assertEqual(generate_issues(guarded["measureScores"]), [])

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
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "UNCALIBRATED_MODEL"
        )


if __name__ == "__main__":
    unittest.main()
