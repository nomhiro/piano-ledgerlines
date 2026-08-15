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

    def test_reference_exposes_pedal_interval_positions(self):
        path = Path(__file__).parent / "fixtures" / "semantic-score.musicxml"
        reference = build_reference(path, tempo_bpm=96)

        self.assertIn("pedalIntervalsBeats", reference)
        intervals = reference["pedalIntervalsBeats"]
        self.assertTrue(all(isinstance(start, float) and isinstance(end, float) for start, end in intervals))
        # capabilities.pedal が真なら区間情報も存在しなければならない。
        # 区間の終了は被覆音符の「開始拍」ではなく「終了拍」（開始拍+長さ）。
        # 譜面(measure1でstart、measure2でstop)では最後に被覆される音符が
        # offset 4.0・長さ4.0のDなので、区間は (0.0, 8.0) になる。
        self.assertTrue(reference["capabilities"]["pedal"])
        self.assertEqual(intervals, [(0.0, 8.0)])

    def test_merge_pedal_intervals_collapses_overlap(self):
        from ledgerlines_worker.reference import merge_pedal_intervals

        merged = merge_pedal_intervals([(0.0, 4.0), (2.0, 6.0)])

        self.assertEqual(merged, [(0.0, 6.0)])

    def test_merge_pedal_intervals_collapses_touching_intervals(self):
        """接触（前の終端＝次の始端）も統合する。

        判定が `start <= merged[-1][1]` の `<=` である（`<` ではない）ことを押さえる。
        `<` にすると (0,2),(2,4) が2区間のまま残り、pedal_ratio は区間ごとの被覆秒数を
        単純加算するので同じ時間帯を二重に数え、被覆率が 1.0 を超えて
        「ペダルだけ不当に低得点」という追跡しにくい症状になる。
        """
        from ledgerlines_worker.reference import merge_pedal_intervals

        merged = merge_pedal_intervals([(0.0, 2.0), (2.0, 4.0)])

        self.assertEqual(merged, [(0.0, 4.0)])

    def test_merge_pedal_intervals_keeps_the_outer_end_when_nested(self):
        """入れ子の場合は外側の終端を保つ。

        終端が `max(merged[-1][1], end)` である（`end` ではない）ことを押さえる。
        `end` にすると (0,5),(1,2) が (0,2) に縮み、参照ペダルが実際より短くなって
        こちらも「ペダルだけ低得点」になる。
        """
        from ledgerlines_worker.reference import merge_pedal_intervals

        merged = merge_pedal_intervals([(0.0, 5.0), (1.0, 2.0)])

        self.assertEqual(merged, [(0.0, 5.0)])


if __name__ == "__main__":
    unittest.main()
