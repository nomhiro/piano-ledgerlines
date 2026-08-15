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
            reference, est_notes, alignment, est_pedal=[], ref_pedal=[], degraded=False
        )
        lenient = compute(
            reference, est_notes, alignment, est_pedal=[], ref_pedal=[], degraded=True
        )

        self.assertIsNotNone(strict["metrics"]["rhythm"])
        self.assertIsNotNone(lenient["metrics"]["rhythm"])
        self.assertGreater(lenient["metrics"]["rhythm"], strict["metrics"]["rhythm"])

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


if __name__ == "__main__":
    unittest.main()
