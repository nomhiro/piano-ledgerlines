from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

import worker_main  # noqa: E402

# align/metrics は pretty_midi 経由で pkg_resources を import し、
# DeprecationWarning を出す（pretty_midi 側の既知の警告で、このタスクの変更とは
# 無関係）。run_analyze() 内部ではこれらをテストメソッド実行中に遅延 import する
# ため、unittest がテスト実行中に警告フィルタを一時的に緩めることで、他の5スイート
# には出ない同じ警告がここでだけ表面化してしまう。他のテストファイル（例:
# test_metrics.py）と同様、モジュール import 時点（unittest 実行前）に一度
# 通しておくことで、出力を pristine に保つ。
from ledgerlines_worker import align, metrics  # noqa: E402,F401

# worker_main.run_analyze() は preprocess/transcribe/align/metrics の各モジュールを
# 「from ledgerlines_worker import align as align_mod」のように毎呼び出しでローカル
# import し、以降は align_mod.load_est(...) のような属性アクセスで呼ぶ。つまり呼び出す
# たびに ledgerlines_worker.align モジュール自身から load_est を都度引いており、
# worker_main 側に関数オブジェクトを固定した名前は存在しない。
# したがって mock.patch は「ledgerlines_worker.<module>.<関数>」（＝実際に属性が
# 引かれる場所）に対して行う。仮に worker_main.py の import 行が
# 「from ledgerlines_worker.align import load_est」のような形に変わった場合は
# worker_main.load_est を直接 patch する必要が出るため、その変更が起きたときは
# このテストが「patch が効かず本物の align.load_est が呼ばれて失敗する」形で
# 気づけるはずである（サイレントに no-op 化はしない）。


def _fixture(n_beats: int = 8):
    """参照譜と、参照と完全一致する演奏（拍=秒の単純対応）を返す。"""
    ref_notes = [
        {
            "index": b,
            "pitch": 60 + (b % 5),
            "measure": 1,
            "startBeat": float(b),
            "dynamicLevel": None,
        }
        for b in range(n_beats)
    ]
    est_notes = [
        {
            "index": b,
            "pitch": 60 + (b % 5),
            "start": float(b),
            "end": float(b) + 0.5,
            "velocity": 80,
        }
        for b in range(n_beats)
    ]
    reference = {
        "notes": ref_notes,
        "beatsPerMeasure": float(n_beats),
        "measures": [{"measure": 1, "tempoExcluded": False}],
        "capabilities": {"dynamics": False, "pedal": True},
        "pedalIntervalsBeats": [[0.0, 4.0]],
    }
    alignment_matched = {
        "pairs": [[i, i] for i in range(n_beats)],
        "missed": [],
        "extra": [],
        "retakes": [],
        "unplayed": [],
    }
    # matchRate = 0（全音符が missed）にして MIN_MATCH_RATE を下回らせ、
    # confidence.apply_fail_closed_policy に alignmentBelowFloor=True を出させる。
    alignment_below_floor = {
        "pairs": [],
        "missed": [n["index"] for n in ref_notes],
        "extra": [],
        "retakes": [],
        "unplayed": [],
    }
    return reference, est_notes, alignment_matched, alignment_below_floor


class RunAnalyzeWiringTests(unittest.TestCase):
    """run_analyze() のスコアリング配線（Task 9）に対する回帰テスト。

    実音声・実採譜モデルは使わず、preprocess/transcribe/align/metrics.load_est を
    スタブに差し替えて run_analyze() 本体（compute / apply_fail_closed_policy の
    呼び出し、ALIGN_FAILED 分岐、pipelineVersion）を実際に実行する。
    """

    def _run(
        self,
        reference: dict,
        est_notes: list[dict],
        alignment: dict,
        est_pedal: list[tuple[float, float]],
        dynamic_range_db: float,
    ):
        with tempfile.TemporaryDirectory(prefix="ll-worker-main-test-") as tmp:
            root = Path(tmp)
            take_id = "take1"
            song_id = "song1"
            data_dir = root / "data"
            (data_dir / "takes").mkdir(parents=True)
            (data_dir / "audio" / take_id).mkdir(parents=True)
            (data_dir / "derived" / song_id).mkdir(parents=True)
            (data_dir / "audio" / take_id / "original.wav").write_bytes(b"\x00")
            (data_dir / "takes" / f"{take_id}.json").write_text(
                json.dumps({"takeId": take_id, "songId": song_id, "status": "uploaded"}),
                encoding="utf-8",
            )
            (data_dir / "derived" / song_id / "reference.json").write_text(
                json.dumps(reference), encoding="utf-8"
            )

            stub_pre = {
                "path": data_dir / "work" / take_id / "clean.wav",
                "dynamicRangeDb": dynamic_range_db,
            }
            with mock.patch(
                "ledgerlines_worker.preprocess.preprocess", return_value=stub_pre
            ), mock.patch(
                "ledgerlines_worker.transcribe.transcribe", return_value=None
            ), mock.patch(
                "ledgerlines_worker.align.load_est", return_value=est_notes
            ), mock.patch(
                "ledgerlines_worker.align.align", return_value=alignment
            ), mock.patch(
                "ledgerlines_worker.metrics.load_est", return_value=(est_notes, est_pedal)
            ):
                # run_analyze() は本番動作として結果 JSON を stdout に print する
                # （Next.js/cloud_worker がそれをパースする）。テスト出力を pristine に
                # 保つため、この print はここで捕らえて捨てる（アサーションには使わない）。
                with contextlib.redirect_stdout(io.StringIO()):
                    code = worker_main.run_analyze(data_dir, take_id)

            doc = json.loads((data_dir / "takes" / f"{take_id}.json").read_text(encoding="utf-8"))
            return code, doc

    def test_alignment_below_floor_fails_before_issue_generation(self):
        reference, est_notes, _matched, below_floor = _fixture()

        # generate_issues が呼ばれたら失敗させる。ALIGN_FAILED 分岐は
        # generate_issues の直前で return するため、これが呼ばれた時点で
        # 「早期 return が効いていない」ことの直接証拠になる。
        with mock.patch(
            "ledgerlines_worker.issues.generate_issues",
            side_effect=AssertionError("generate_issues must not run after ALIGN_FAILED"),
        ):
            code, doc = self._run(
                reference, est_notes, below_floor, est_pedal=[], dynamic_range_db=20.0
            )

        self.assertEqual(code, 1)
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["failure"]["code"], "ALIGN_FAILED")
        self.assertEqual(doc["analysis"]["pipelineVersion"], "0.3.0-m5-metric-policy")
        # Minor 2: failed 分岐も completed 分岐と同じ診断情報（preprocess/baseTempo）を持つ。
        self.assertIn("preprocess", doc["analysis"])
        self.assertIn("baseTempo", doc["analysis"])
        self.assertIn("diagnostics", doc["analysis"])
        self.assertNotIn("issues", doc)

    def test_missing_pedal_intervals_key_degrades_without_raising(self):
        """旧 reference.json（pedalIntervalsBeats 追加前）を想定した回帰テスト。"""
        reference, est_notes, matched, _below_floor = _fixture()
        del reference["pedalIntervalsBeats"]

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=20.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "completed")
        self.assertEqual(doc["analysis"]["pipelineVersion"], "0.3.0-m5-metric-policy")
        # ref_pedal_beats=[] に degrade され、pedal_reference_available=False として
        # confidence 層に伝わるため、pedal は測定不能扱いになる。
        self.assertIsNone(doc["metrics"]["pedal"])
        self.assertEqual(
            doc["metricsNAReason"]["pedal"],
            "この曲の参照譜にペダル位置が含まれていないため測定できません。楽譜を再登録すると測定できます。",
        )

    def test_completed_path_sets_pipeline_version_and_scores_pedal(self):
        reference, est_notes, matched, _below_floor = _fixture()

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=20.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "completed")
        self.assertEqual(doc["analysis"]["pipelineVersion"], "0.3.0-m5-metric-policy")
        self.assertIn("evaluation", doc)
        # 参照譜に pedalIntervalsBeats があり演奏ペダルも一致しているため、
        # pedal_reference_available=True が正しく伝われば pedal は採点される。
        # このキーワードが渡し忘れられている（デフォルト False のまま）と、
        # test_missing_pedal_intervals_key_degrades_without_raising と区別できず
        # 見逃すため、ここで明示的に「採点される」側を確認する。
        self.assertIsNotNone(doc["metrics"]["pedal"])
        self.assertNotIn("pedal", doc["metricsNAReason"])


if __name__ == "__main__":
    unittest.main()
