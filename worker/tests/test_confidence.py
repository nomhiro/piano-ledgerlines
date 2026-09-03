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
        """Issue #8（採譜ノイズ 521 音で pitch が 9.99 に崩れた実テイク）の再現。

        フィクスチャ本体も返す。診断値や期待 status をテスト側にリテラルで書き写すと
        フィクスチャとの結合が切れ、フィクスチャだけが実装と矛盾したまま緑になる
        （Issue #8 の基準ケースを記述する唯一のファイルなので、次に読む人を誤導する）。
        """
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
        return result, reference, alignment, fixture

    def test_issue_8_diagnostic_scores_pitch_as_reference_value(self):
        """採譜ノイズの多い実録音でも pitch を現行式の参考値として返す。"""
        result, reference, alignment, fixture = self._issue8_case()
        expected = fixture["expected"]

        guarded = apply_fail_closed_policy(
            result,
            reference,
            alignment,
            fixture["transcribedNotes"],
            None,
            dynamic_range_db=18.0,
            pedal_reference_available=False,
        )

        # フィクスチャの expected を実際に読む（リテラルで書き写さない）。
        self.assertEqual(guarded["evaluation"]["status"], expected["evaluationStatus"])
        for metric, key in (
            ("pitch", "pitchStatus"),
            ("rhythm", "rhythmStatus"),
            ("tempo", "tempoStatus"),
            ("dynamics", "dynamicsStatus"),
            ("pedal", "pedalStatus"),
        ):
            self.assertEqual(
                guarded["metricEvaluations"][metric]["status"], expected[key], metric
            )
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "PITCH_FORMULA_UNVALIDATED"
        )
        # 参照ペダルが未再生成なので測定対象外
        self.assertEqual(
            guarded["metricEvaluations"]["pedal"]["reasonCode"],
            "PEDAL_REFERENCE_NOT_REGENERATED",
        )
        # diagnostics は監査の中心で、alignmentBelowFloor の判断根拠でもある。
        # 指標別ポリシーに変わっても Issue #8 の実測値は変わらない。
        self.assertEqual(guarded["diagnostics"]["referenceNotes"], fixture["referenceNotes"])
        self.assertEqual(
            guarded["diagnostics"]["transcribedNotes"], fixture["transcribedNotes"]
        )
        self.assertEqual(guarded["diagnostics"]["matchedNotes"], fixture["matchedNotes"])
        self.assertEqual(guarded["diagnostics"]["extraNotes"], fixture["extraNotes"])
        # rawScores は内部計算のみで外に出さない。
        self.assertNotIn("rawScores", guarded)
        # 小節レベルでも take レベルの具体的な理由がそのまま伝播すること（汎用の
        # INSUFFICIENT_ALIGNMENT_EVIDENCE に上書きされない）。この小節の pedal 素点は
        # None だが、take レベルの pedal は「scored」ではなく「参照譜未再生成で
        # unavailable」なので、小節側も同じ理由を引き継ぐ。
        measure_pedal = guarded["measureScores"][0]["metricEvaluations"]["pedal"]
        self.assertEqual(measure_pedal["status"], "unavailable")
        self.assertEqual(measure_pedal["reasonCode"], "PEDAL_REFERENCE_NOT_REGENERATED")
        # measureScores[0]["score"] は WEIGHTS を pedal 除外後に再正規化した
        # 加重平均になる（手計算での導出、report に記載）:
        #   (9.99*0.28 + 63.3*0.28 + 95.93*0.17 + 98.58*0.17) / 0.9
        #   = 59.54
        self.assertEqual(guarded["measureScores"][0]["score"], 59.54)
        # rhythm/tempo/dynamics が scored になったことで指摘生成が動くようになる（spec 4.1）
        issues = generate_issues(guarded["measureScores"])
        self.assertTrue(any(issue["metric"] == "rhythm" for issue in issues))

    def test_overall_score_includes_unvalidated_pitch_reference_value(self):
        """pitch の現行式による参考値を含めて総合点を返す。"""
        result, reference, alignment, fixture = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, fixture["transcribedNotes"], None,
            dynamic_range_db=18.0,
        )

        self.assertEqual(guarded["overallScore"], 59.54)
        self.assertEqual(guarded["evaluation"]["status"], "scored")

    def _repeat_case(self, measures: list[dict]):
        """演奏順小節 1 と 17 が同じ楽譜上の小節 1 に写る、繰り返し展開後の形。

        `measures` だけを差し替えられるようにして、`scoreMeasure` の有無を
        テストごとに変えられるようにしている。
        """
        reference = {
            "notes": [{"index": i, "measure": 1 if i < 5 else 17} for i in range(10)],
            "measures": measures,
        }
        alignment = {
            "pairs": [[i, i] for i in range(10)],
            "missed": [],
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        metrics = {"pitch": 50, "rhythm": 50, "tempo": 50, "dynamics": None, "pedal": None}
        result = {
            "overallScore": 50,
            "metrics": dict(metrics),
            "measureScores": [
                {"measure": 1, "refNotes": 5, "score": 50, "metrics": dict(metrics)},
                {"measure": 17, "refNotes": 5, "score": 50, "metrics": dict(metrics)},
            ],
        }
        return result, reference, alignment

    def test_score_measure_comes_from_the_reference_not_the_performance_order(self):
        """楽譜上の小節番号は reference.py が算出した値を保持する（#37）。

        繰り返しを展開すると演奏順小節 17 は楽譜上の小節 1 に写る。ここで演奏順の
        番号を書くと、楽譜ビューの重ね合わせ（`scoreMeasure` で引く）がずれる。
        """
        result, reference, alignment = self._repeat_case(
            [
                {"measure": 1, "scoreMeasure": 1, "tempoExcluded": False},
                {"measure": 17, "scoreMeasure": 1, "tempoExcluded": False},
            ]
        )

        guarded = apply_fail_closed_policy(result, reference, alignment, 10)

        by_measure = {ms["measure"]: ms for ms in guarded["measureScores"]}
        self.assertEqual(by_measure[1]["scoreMeasure"], 1)
        self.assertEqual(by_measure[17]["scoreMeasure"], 1)
        # 演奏順の番号は別フィールドとして保たれる。
        self.assertEqual(sorted(by_measure), [1, 17])

    def test_score_measure_falls_back_when_the_reference_predates_the_field(self):
        """`scoreMeasure` を持たない古い参照譜は演奏順の番号にフォールバックする。"""
        result, reference, alignment = self._repeat_case(
            [
                {"measure": 1, "tempoExcluded": False},
                {"measure": 17, "tempoExcluded": False},
            ]
        )

        guarded = apply_fail_closed_policy(result, reference, alignment, 10)

        by_measure = {ms["measure"]: ms for ms in guarded["measureScores"]}
        self.assertEqual(by_measure[1]["scoreMeasure"], 1)
        self.assertEqual(by_measure[17]["scoreMeasure"], 17)

    def test_score_measure_falls_back_when_the_measure_is_absent_from_the_reference(self):
        """参照譜の measures に該当する演奏順小節が無い場合もフォールバックする。"""
        result, reference, alignment = self._repeat_case(
            [{"measure": 1, "scoreMeasure": 1, "tempoExcluded": False}]
        )

        guarded = apply_fail_closed_policy(result, reference, alignment, 10)

        by_measure = {ms["measure"]: ms for ms in guarded["measureScores"]}
        self.assertEqual(by_measure[1]["scoreMeasure"], 1)
        self.assertEqual(by_measure[17]["scoreMeasure"], 17)

    def test_agc_makes_dynamics_unavailable(self):
        result, reference, alignment, fixture = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, fixture["transcribedNotes"], None,
            dynamic_range_db=7.0,
        )

        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["status"], "unavailable")
        self.assertEqual(guarded["metricEvaluations"]["dynamics"]["reasonCode"], "AGC_DETECTED")

    def test_non_sustain_only_pedal_marks_do_not_advise_re_registration(self):
        """楽譜のペダル記号が全て sostenuto/soft の場合。

        capabilities.pedal は hasPedalMark だけを見るので True になるが、区間抽出は
        sustain のみ拾うので pedalIntervalsBeats は空になる。この状態で
        PEDAL_REFERENCE_NOT_REGENERATED（「楽譜を再登録すると測定できます」）を出すと、
        再登録しても永久に同じ結果になる作業をユーザーに指示することになる。
        """
        result, reference, alignment, fixture = self._issue8_case()

        guarded = apply_fail_closed_policy(
            result, reference, alignment, fixture["transcribedNotes"], None,
            dynamic_range_db=18.0,
            pedal_reference_available=False,
            pedal_reference_regenerated=True,  # キーはあるが sustain 区間が空
        )

        pedal = guarded["metricEvaluations"]["pedal"]
        self.assertEqual(pedal["status"], "unavailable")
        self.assertEqual(pedal["reasonCode"], "NO_MEASURABLE_PEDAL_INTERVALS")
        self.assertNotIn("再登録", pedal["reason"])

    def test_low_match_rate_is_rejected(self):
        """別の曲の音声が来た場合にスコアを出さない安全網。"""
        result, reference, alignment, fixture = self._issue8_case()
        alignment["pairs"] = alignment["pairs"][:100]  # matchRate 約 0.08

        guarded = apply_fail_closed_policy(
            result, reference, alignment, fixture["transcribedNotes"], None,
            dynamic_range_db=18.0,
        )

        self.assertTrue(guarded["alignmentBelowFloor"])
        self.assertIsNone(guarded["overallScore"])
        for key in ("pitch", "rhythm", "tempo", "dynamics", "pedal"):
            # below_floor は decide() の最初の分岐で確定するため、常に withheld
            # （unavailable に落ちる経路は存在しない）。
            self.assertEqual(guarded["metricEvaluations"][key]["status"], "withheld")
            self.assertEqual(guarded["metricEvaluations"][key]["reasonCode"], "ALIGNMENT_BELOW_FLOOR")
            # 小節レベルも同じ withheld を継承する（take と食い違わない）。
            self.assertEqual(
                guarded["measureScores"][0]["metricEvaluations"][key]["status"], "withheld"
            )

    def test_matchrate_exactly_at_floor_boundary_is_not_below_floor(self):
        """MIN_MATCH_RATE の判定は `<` なので、ちょうど0.30ならフロア未満ではない。"""
        reference = {"notes": [{"index": i, "measure": 1} for i in range(10)]}
        alignment = {
            "pairs": [[0, 0], [1, 1], [2, 2]],  # matchRate = 3/10 = 0.30 ちょうど
            "missed": list(range(3, 10)),
            "extra": [],
            "retakes": [],
            "unplayed": [],
        }
        result = {
            "overallScore": 50,
            "metrics": {"pitch": 50, "rhythm": 50, "tempo": 50, "dynamics": None, "pedal": None},
            "measureScores": [
                {
                    "measure": 1,
                    "refNotes": 10,
                    "score": 50,
                    "metrics": {
                        "pitch": 50,
                        "rhythm": 50,
                        "tempo": 50,
                        "dynamics": None,
                        "pedal": None,
                    },
                }
            ],
        }

        guarded = apply_fail_closed_policy(result, reference, alignment, 3)

        self.assertFalse(guarded["alignmentBelowFloor"])
        self.assertEqual(guarded["metricEvaluations"]["rhythm"]["status"], "scored")
        self.assertEqual(guarded["metricEvaluations"]["tempo"]["status"], "scored")

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
        self.assertEqual(guarded["overallScore"], 100)
        self.assertEqual(
            guarded["metricEvaluations"]["pitch"]["reasonCode"], "PITCH_FORMULA_UNVALIDATED"
        )

    def test_approved_data_derived_threshold_does_not_withhold_pitch(self):
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
        self.assertEqual(guarded["metrics"]["pitch"], 90)
        self.assertEqual(guarded["overallScore"], 90)

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
