from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from ledgerlines_worker.omr_job import MAX_ATTEMPTS, process_omr_job  # noqa: E402


class FakeStore:
    """`converting_score` の曲1件を持つストア。呼ばれた操作を記録する。"""

    def __init__(self, song: dict | None = None):
        self.song = song
        self.patches: list[dict] = []
        self.uploaded: list[str] = []
        self.raise_on_update = False

    def get_song(self, song_id: str, user_id: str):
        return self.song

    def update_song(self, song_id: str, user_id: str, patch: dict):
        if self.raise_on_update:
            raise RuntimeError("cosmos unavailable")
        self.patches.append(patch)
        if self.song is not None:
            self.song.update(patch)
        return self.song

    def download_score(self, song: dict, target_dir: Path) -> Path:
        target = target_dir / "score.pdf"
        target.write_bytes(b"%PDF-1.4 fake")
        return target

    def upload_preview(self, song: dict, file_name: str, source: Path) -> None:
        self.uploaded.append(file_name)


def converting_song() -> dict:
    return {
        "id": "song_1",
        "userId": "usr_1",
        "status": "converting_score",
        "scoreFileName": "original.pdf",
        "sourceScoreFileName": "original.pdf",
    }


def job() -> dict:
    return {"schemaVersion": 1, "jobId": "job_1", "songId": "song_1", "userId": "usr_1"}


def write_song_json(work_dir: Path, song_id: str, payload: dict) -> None:
    """run_omr が書く曲 JSON を模擬する。"""
    songs = work_dir / "songs"
    songs.mkdir(parents=True, exist_ok=True)
    (songs / f"{song_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def written_files(work_dir: Path, song_id: str, names: list[str]) -> None:
    """run_omr が生成した成果物を模擬する。"""
    score_dir = work_dir / "scores" / song_id
    score_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        (score_dir / name).write_text("x", encoding="utf-8")


class ProcessOmrJobTests(unittest.TestCase):
    def run_job(self, store, run_omr, dequeue_count=1):
        with tempfile.TemporaryDirectory() as temp:
            return process_omr_job(store, job(), dequeue_count, Path(temp), run_omr)

    def test_missing_song_is_skipped(self):
        store = FakeStore(song=None)
        outcome = self.run_job(store, lambda work_dir, song_id: 0)
        self.assertEqual(outcome, "skipped")
        self.assertEqual(store.patches, [])

    def test_song_not_converting_is_skipped(self):
        # 再配信の重複、または利用者が正しい楽譜へ差し替えて別ジョブが処理済み。
        # 完了した曲を OMR ドラフトで上書きするのは害にしかならない。
        song = converting_song()
        song["status"] = "ready"
        store = FakeStore(song)
        outcome = self.run_job(store, lambda work_dir, song_id: 0)
        self.assertEqual(outcome, "skipped")
        self.assertEqual(store.patches, [])

    def test_successful_conversion_moves_to_reviewing_score(self):
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            written_files(work_dir, song_id, ["score.musicxml", "score.mid"])
            write_song_json(work_dir, song_id, {
                "status": "reviewing_score",
                "scoreFileName": "score.musicxml",
                "scoreSource": "pdf",
                "omrEngine": "audiveris",
                "omrError": None,
                "previewScoreFileName": "score.musicxml",
                "previewMidiFileName": "score.mid",
                "warnings": [],
            })
            return 0

        outcome = self.run_job(store, run_omr)
        self.assertEqual(outcome, "completed")
        patch = store.patches[-1]
        self.assertEqual(patch["status"], "reviewing_score")
        self.assertEqual(patch["scoreFileName"], "score.musicxml")
        self.assertEqual(patch["scoreSource"], "pdf")
        self.assertIsNone(patch["omrError"])
        self.assertEqual(patch["previewMidiFileName"], "score.mid")

    def test_generated_files_are_uploaded_without_duplicates(self):
        # scoreFileName と previewScoreFileName は同一ファイルになり得る。
        # 同じ名前を2回上げない。
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            written_files(work_dir, song_id, ["score.musicxml", "score.mid"])
            write_song_json(work_dir, song_id, {
                "status": "reviewing_score",
                "scoreFileName": "score.musicxml",
                "previewScoreFileName": "score.musicxml",
                "previewMidiFileName": "score.mid",
            })
            return 0

        self.run_job(store, run_omr)
        self.assertEqual(sorted(store.uploaded), ["score.mid", "score.musicxml"])

    def test_nonzero_exit_moves_to_omr_failed(self):
        # 失敗の終端は omr_failed（api.md:278）。awaiting_score ではない。
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            write_song_json(work_dir, song_id, {
                "status": "omr_failed",
                "omrError": "Audiveris did not produce exactly one MusicXML file",
            })
            return 1

        outcome = self.run_job(store, run_omr)
        self.assertEqual(outcome, "failed")
        patch = store.patches[-1]
        self.assertEqual(patch["status"], "omr_failed")
        self.assertIn("MusicXML", patch["omrError"])
        self.assertEqual(store.uploaded, [])

    def test_status_not_reviewing_after_zero_exit_is_treated_as_failure(self):
        # 終了コード0でも曲が reviewing_score になっていないなら成功ではない。
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            write_song_json(work_dir, song_id, {"status": "omr_failed", "omrError": "boom"})
            return 0

        self.assertEqual(self.run_job(store, run_omr), "failed")
        self.assertEqual(store.patches[-1]["status"], "omr_failed")

    def test_transient_failure_below_the_cap_is_raised(self):
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            raise RuntimeError("blob unavailable")

        with self.assertRaises(RuntimeError):
            self.run_job(store, run_omr, dequeue_count=MAX_ATTEMPTS - 1)

    def test_cap_reached_terminates_as_omr_failed(self):
        store = FakeStore(converting_song())

        def run_omr(work_dir: Path, song_id: str) -> int:
            raise RuntimeError("blob unavailable")

        outcome = self.run_job(store, run_omr, dequeue_count=MAX_ATTEMPTS)
        self.assertEqual(outcome, "exhausted")
        patch = store.patches[-1]
        self.assertEqual(patch["status"], "omr_failed")
        self.assertIn("blob unavailable", patch["omrError"])

    def test_cap_reached_without_identifiers_is_skipped(self):
        # 曲を特定できないメッセージ。残しても同じ KeyError を繰り返すだけ。
        store = FakeStore(converting_song())
        with tempfile.TemporaryDirectory() as temp:
            outcome = process_omr_job(
                store, {"jobId": "job_1"}, MAX_ATTEMPTS, Path(temp),
                lambda work_dir, song_id: 0,
            )
        self.assertEqual(outcome, "skipped")
        self.assertEqual(store.patches, [])

    def test_cap_reached_but_update_fails_is_raised(self):
        # 終端状態を書けないままメッセージを消すと、曲が converting_score のまま
        # 誰も再開できない状態で孤立する。残せば Cosmos 回復後に終端できる。
        store = FakeStore(converting_song())
        store.raise_on_update = True

        def run_omr(work_dir: Path, song_id: str) -> int:
            raise RuntimeError("blob unavailable")

        with self.assertRaises(RuntimeError):
            self.run_job(store, run_omr, dequeue_count=MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
