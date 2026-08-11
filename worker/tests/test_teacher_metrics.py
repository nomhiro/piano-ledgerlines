from __future__ import annotations

import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.issues import generate_issues  # noqa: E402
from ledgerlines_worker.teacher_metrics import extract_candidate_observations  # noqa: E402


class TeacherMetricObservationTests(unittest.TestCase):
    def test_candidate_observations_are_never_publishable_scores(self):
        reference = {
            "notes": [
                {
                    "index": 0,
                    "measure": 1,
                    "staff": 1,
                    "voice": "1",
                }
            ],
            "measures": [
                {
                    "measure": 1,
                    "tempoExcluded": True,
                    "tempoText": ["rit."],
                    "hasFermata": False,
                    "dynamicMarks": ["mf"],
                    "hairpins": [],
                    "pedalMarks": ["start"],
                    "pitchClasses": [0, 4, 7],
                }
            ],
        }
        observations = extract_candidate_observations(
            reference,
            [{"velocity": 88}],
            {"pairs": [[0, 0]]},
            [{"measure": 1, "tempoBpm": 72}],
        )
        self.assertFalse(observations["publishable"])
        self.assertEqual(observations["status"], "uncalibrated")
        self.assertTrue(
            observations["tempoExpression"][0]["excludedFromMechanicalPenalty"]
        )
        self.assertEqual(observations["voiceBalance"][0]["meanVelocity"], 88)

    def test_scored_issue_contains_evidence_and_practice_action(self):
        issues = generate_issues(
            [
                {
                    "measure": 4,
                    "metrics": {"tempo": 30},
                    "metricEvaluations": {
                        "tempo": {"status": "scored", "confidence": 0.9}
                    },
                }
            ]
        )
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["confidence"], 0.9)
        self.assertIn("averageScore", issues[0]["evidence"])
        self.assertTrue(issues[0]["practiceAction"])


if __name__ == "__main__":
    unittest.main()
