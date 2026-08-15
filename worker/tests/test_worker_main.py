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


def _fixture(n_beats: int = 8, dynamics_capable: bool = False):
    """参照譜と、参照と完全一致する演奏（拍=秒の単純対応）を返す。

    `dynamics_capable` は capabilities.dynamics を立てる。既定を False にしているのは
    ref_notes の dynamicLevel が全て None（＝強弱の素点が出ない）ためで、AGC ゲートの
    配線を見るテストだけがこれを True にする。
    """
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
        "capabilities": {"dynamics": dynamics_capable, "pedal": True},
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
        transcribe_error: Exception | None = None,
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
            transcribe_kwargs = (
                {"side_effect": transcribe_error}
                if transcribe_error is not None
                else {"return_value": None}
            )
            with mock.patch(
                "ledgerlines_worker.preprocess.preprocess", return_value=stub_pre
            ), mock.patch(
                "ledgerlines_worker.transcribe.transcribe", **transcribe_kwargs
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
        self.assertEqual(doc["analysis"]["pipelineVersion"], worker_main.PIPELINE_VERSION)
        # Minor 2: failed 分岐も completed 分岐と同じ診断情報（preprocess/baseTempo）を持つ。
        self.assertIn("preprocess", doc["analysis"])
        self.assertIn("baseTempo", doc["analysis"])
        self.assertIn("diagnostics", doc["analysis"])
        self.assertNotIn("issues", doc)
        # 算出済みの evaluation を保存する（これが無いとテイク詳細の総合スコア欄が
        # 「総合スコア未算出」になり、保留の理由が読めない）。素点は保留されている
        # ので metrics は書かない。
        self.assertEqual(doc["evaluation"]["status"], "withheld")
        self.assertEqual(doc["evaluation"]["reasonCode"], "ALIGNMENT_BELOW_FLOOR")
        self.assertEqual(
            doc["metricEvaluations"]["rhythm"]["reasonCode"], "ALIGNMENT_BELOW_FLOOR"
        )
        self.assertNotIn("metrics", doc)

    def test_missing_pedal_intervals_key_degrades_without_raising(self):
        """旧 reference.json（pedalIntervalsBeats 追加前）を想定した回帰テスト。"""
        reference, est_notes, matched, _below_floor = _fixture()
        del reference["pedalIntervalsBeats"]

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=20.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "completed")
        self.assertEqual(doc["analysis"]["pipelineVersion"], worker_main.PIPELINE_VERSION)
        # ref_pedal_beats=[] に degrade され、pedal_reference_available=False として
        # confidence 層に伝わるため、pedal は測定不能扱いになる。
        self.assertIsNone(doc["metrics"]["pedal"])
        self.assertEqual(
            doc["metricsNAReason"]["pedal"],
            "この曲の参照譜にペダル位置が含まれていないため測定できません。楽譜を再登録すると測定できます。",
        )

    def test_empty_pedal_intervals_key_reports_unmeasurable_instead_of_re_registration(self):
        """キーはあるが sustain 区間が空（楽譜が sostenuto/soft のみ）の場合。

        `pedal_reference_regenerated=` の配線を押さえる。渡し忘れると既定 False で
        PEDAL_REFERENCE_NOT_REGENERATED に落ち、
        test_missing_pedal_intervals_key_degrades_without_raising と区別できないため
        見逃す（再登録しても直らない状態に「再登録してください」と案内してしまう）。
        """
        reference, est_notes, matched, _below_floor = _fixture()
        reference["pedalIntervalsBeats"] = []

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=20.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "completed")
        self.assertEqual(
            doc["metricEvaluations"]["pedal"]["reasonCode"], "NO_MEASURABLE_PEDAL_INTERVALS"
        )
        self.assertNotIn("再登録", doc["metricsNAReason"]["pedal"])

    def test_completed_path_sets_pipeline_version_and_scores_pedal(self):
        reference, est_notes, matched, _below_floor = _fixture()

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=20.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "completed")
        self.assertEqual(doc["analysis"]["pipelineVersion"], worker_main.PIPELINE_VERSION)
        self.assertIn("evaluation", doc)
        # 参照譜に pedalIntervalsBeats があり演奏ペダルも一致しているため、
        # pedal_reference_available=True が正しく伝われば pedal は採点される。
        # このキーワードが渡し忘れられている（デフォルト False のまま）と、
        # test_missing_pedal_intervals_key_degrades_without_raising と区別できず
        # 見逃すため、ここで明示的に「採点される」側を確認する。
        self.assertIsNotNone(doc["metrics"]["pedal"])
        self.assertNotIn("pedal", doc["metricsNAReason"])

    def test_agc_dynamic_range_reaches_the_dynamics_gate(self):
        """`dynamic_range_db=` の配線を押さえる。

        AGC ゲートは `dynamics` の唯一の安全装置で、M4 が -45.1 点と実測した崩壊した
        強弱スコアを公開しないためだけに存在する。他のテストは全て
        dynamic_range_db=20.0 を渡すので、この1本が無いと
        `worker_main.py` の `dynamic_range_db=dynamic_range_db` を削除しても全テストが
        緑のまま通ってしまう（confidence 側の既定は None ＝ AGC 判定を行わない）。
        """
        reference, est_notes, matched, _below_floor = _fixture(dynamics_capable=True)

        code, doc = self._run(
            reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=7.0
        )

        self.assertEqual(code, 0)
        self.assertEqual(doc["metricEvaluations"]["dynamics"]["reasonCode"], "AGC_DETECTED")
        self.assertEqual(doc["metricEvaluations"]["dynamics"]["status"], "unavailable")
        self.assertIsNone(doc["metrics"]["dynamics"])

    def test_degraded_flag_reaches_metrics_compute(self):
        """`degraded=` の配線を押さえる。

        劣化録音では rhythm のデッドゾーンを 0.03 → 0.045 拍に緩める（metrics.md 7.4）。
        緩和が死んでも素点は出続けるので出力からは検出できない。よって
        `metrics.compute` を wraps で包み、渡された引数を直接見る。
        dynamic_range_db=7.0 は DEGRADED_DYNAMIC_RANGE_DB(14.0) 未満なので True 側。
        """
        from ledgerlines_worker import metrics as metrics_mod

        reference, est_notes, matched, _below_floor = _fixture()

        with mock.patch(
            "ledgerlines_worker.metrics.compute", wraps=metrics_mod.compute
        ) as compute_spy:
            code, _doc = self._run(
                reference, est_notes, matched, est_pedal=[(0.0, 4.0)], dynamic_range_db=7.0
            )

        self.assertEqual(code, 0)
        compute_spy.assert_called_once()
        self.assertIs(compute_spy.call_args.kwargs["degraded"], True)

    def test_pipeline_version_is_a_single_constant(self):
        """バージョン文字列がテストにも実装にも散らばらないことを保証する。

        片方だけ上げる事故を防ぐため、実装は worker_main.PIPELINE_VERSION 1箇所で持つ。
        現在の値も併せて固定し、意図しない変更に気づけるようにする。
        """
        self.assertEqual(worker_main.PIPELINE_VERSION, "0.3.0-m5-metric-policy")

    def test_missing_checkpoint_raises_actionable_failure_code(self):
        """S2（transcribe.transcribe）が TranscribeError を投げた場合、INTERNAL に
        丸めず専用の failure.code を書く。かつ内部パスなどの詳細を
        failure.message に出さず、analysis.error にのみ残す
        （デプロイ直後に実際に起きた不具合の再発防止）。
        """
        from ledgerlines_worker.transcribe import TranscribeError

        reference, est_notes, matched, _below_floor = _fixture()
        secret_path = (
            "/root/piano_transcription_inference_data/"
            "note_F1=0.9677_pedal_F1=0.9186.pth"
        )

        code, doc = self._run(
            reference,
            est_notes,
            matched,
            est_pedal=[(0.0, 4.0)],
            dynamic_range_db=20.0,
            transcribe_error=TranscribeError(
                "MODEL_CHECKPOINT_MISSING",
                f"transcription checkpoint not found at {secret_path}",
            ),
        )

        self.assertEqual(code, 1)
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["failure"]["code"], "MODEL_CHECKPOINT_MISSING")
        self.assertNotIn(secret_path, doc["failure"]["message"])
        self.assertIn(secret_path, doc["analysis"]["error"])

    def test_unexpected_exception_hides_internal_detail_from_user_message(self):
        """想定外の例外（catch-all）は failure.message に str(exc) を
        そのまま出さない。詳細は analysis.error に残し、failure.code は
        INTERNAL のまま（TranscribeError のような専用コードを持たない失敗である）。
        """
        reference, est_notes, matched, _below_floor = _fixture()
        secret = "/root/some/internal/implementation/detail.pth"

        code, doc = self._run(
            reference,
            est_notes,
            matched,
            est_pedal=[(0.0, 4.0)],
            dynamic_range_db=20.0,
            transcribe_error=RuntimeError(secret),
        )

        self.assertEqual(code, 1)
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["failure"]["code"], "INTERNAL")
        self.assertNotIn(secret, doc["failure"]["message"])
        self.assertIn(secret, doc["analysis"]["error"])


if __name__ == "__main__":
    unittest.main()
