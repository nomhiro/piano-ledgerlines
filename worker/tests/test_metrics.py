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


if __name__ == "__main__":
    unittest.main()
