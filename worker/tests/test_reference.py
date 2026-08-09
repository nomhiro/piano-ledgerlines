from __future__ import annotations

import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.reference import build_reference  # noqa: E402


class ReferenceSemanticsTests(unittest.TestCase):
    def test_extracts_musicxml_semantics(self):
        path = Path(__file__).parent / "fixtures" / "semantic-score.musicxml"
        reference = build_reference(path, tempo_bpm=96)

        self.assertEqual(reference["schemaVersion"], "2.0")
        self.assertTrue(reference["capabilities"]["dynamics"])
        self.assertTrue(reference["capabilities"]["tempoExpression"])
        self.assertTrue(reference["capabilities"]["voices"])
        self.assertTrue(reference["capabilities"]["articulation"])
        self.assertTrue(reference["capabilities"]["pedal"])
        self.assertEqual({note["staff"] for note in reference["notes"]}, {1, 2})
        self.assertIn("accent", reference["notes"][0]["articulations"])
        self.assertTrue(reference["notes"][0]["slurred"])
        self.assertTrue(reference["measures"][1]["tempoExcluded"])
        self.assertTrue(reference["measures"][2]["tempoExcluded"])
        self.assertTrue(reference["measures"][3]["tempoExcluded"])
        self.assertTrue(reference["measures"][1]["hasFermata"])
        self.assertEqual(reference["measures"][1]["barline"], "final")


if __name__ == "__main__":
    unittest.main()
