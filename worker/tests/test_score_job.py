from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from ledgerlines_worker.score_job import MAX_ATTEMPTS, process_score_job  # noqa: E402


def _song(**overrides) -> dict:
    song = {
        "id": "song_abc",
        "userId": "usr_1",
        "status": "parsing_score",
        "scoreFileName": "score.musicxml",
        "measureCount": None,
    }
    song.update(overrides)
    return song


class FakeStore:
    """cloud_worker.CloudStore の代役。Blob/Cosmos の代わりにメモリと一時領域を使う。"""

    def __init__(self, song: dict | None) -> None:
        self.song = song
        self.patches: list[dict] = []
        self.uploaded: dict[str, bytes] = {}

    def get_song(self, song_id: str, user_id: str) -> dict | None:
        if self.song is None or self.song["id"] != song_id or self.song["userId"] != user_id:
            return None
        return dict(self.song)

    def update_song(self, song_id: str, user_id: str, patch: dict) -> None:
        self.patches.append(patch)
        assert self.song is not None
        self.song.update(patch)

    def download_score(self, song: dict, target_dir: Path) -> Path:
        target = target_dir / "score.musicxml"
        target.write_text("<score-partwise/>", encoding="utf-8")
        return target

    def upload_reference(self, song: dict, source: Path) -> None:
        self.uploaded["reference.json"] = source.read_bytes()

    def upload_preview(self, song: dict, file_name: str, source: Path) -> None:
        self.uploaded[file_name] = source.read_bytes()


class ExplodingStore(FakeStore):
    def download_score(self, song: dict, target_dir: Path) -> Path:
        raise RuntimeError("blob download failed")


def _job(song_id: str = "song_abc", user_id: str = "usr_1") -> dict:
    return {
        "schemaVersion": 1,
        "jobId": "job_1",
        "songId": song_id,
        "userId": user_id,
        "attempt": 1,
        "correlationId": "corr_1",
    }


def _run_reference_ok(data_dir: Path, song_id: str) -> int:
    """成功した run_reference と同じ副作用（ファイル出力＋曲JSONの更新）を再現する。"""
    song_file = data_dir / "songs" / f"{song_id}.json"
    song = json.loads(song_file.read_text(encoding="utf-8"))
    song.update({
        "status": "ready",
        "measureCount": 48,
        "scoreMeasureCount": 48,
        "keySignature": "G major",
        "timeSignature": "4/4",
        "detectedTempo": 96,
        "hasRepeats": False,
        "warnings": [{"code": "PREVIEW_MIDI_UNAVAILABLE", "message": "テスト用"}],
        "previewScoreFileName": "score.musicxml",
        "previewMidiFileName": "preview.mid",
    })
    song_file.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    reference = data_dir / "derived" / song_id / "reference.json"
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.write_text('{"measureCount": 48}', encoding="utf-8")
    (data_dir / "scores" / song_id / "preview.mid").write_bytes(b"MThd")
    return 0


def _run_reference_parse_error(data_dir: Path, song_id: str) -> int:
    """パース失敗した run_reference（worker_main.py:157-163）と同じ副作用。"""
    song_file = data_dir / "songs" / f"{song_id}.json"
    song = json.loads(song_file.read_text(encoding="utf-8"))
    song.update({"status": "awaiting_score", "lastScoreError": "小節線が閉じていません"})
    song_file.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
    return 1


class ProcessScoreJobTest(unittest.TestCase):
    def test_success_uploads_artifacts_and_marks_song_ready(self):
        store = FakeStore(_song())
        with tempfile.TemporaryDirectory() as temp:
            outcome = process_score_job(store, _job(), 1, Path(temp), _run_reference_ok)

        self.assertEqual(outcome, "completed")
        self.assertEqual(store.song["status"], "ready")
        self.assertEqual(store.song["measureCount"], 48)
        self.assertEqual(store.song["timeSignature"], "4/4")
        self.assertEqual(store.song["previewScoreFileName"], "score.musicxml")
        self.assertEqual(
            sorted(store.uploaded),
            ["preview.mid", "reference.json", "score.musicxml"],
        )

    def test_parse_error_marks_song_awaiting_score_without_uploading(self):
        store = FakeStore(_song())
        with tempfile.TemporaryDirectory() as temp:
            outcome = process_score_job(store, _job(), 1, Path(temp), _run_reference_parse_error)

        self.assertEqual(outcome, "failed")
        self.assertEqual(store.song["status"], "awaiting_score")
        self.assertEqual(store.song["lastScoreError"], "小節線が閉じていません")
        self.assertEqual(store.uploaded, {})

    def test_infrastructure_failure_retries_until_attempts_are_exhausted(self):
        store = ExplodingStore(_song())
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                process_score_job(store, _job(), 1, Path(temp), _run_reference_ok)
            self.assertEqual(store.song["status"], "parsing_score")

            outcome = process_score_job(store, _job(), MAX_ATTEMPTS, Path(temp), _run_reference_ok)

        self.assertEqual(outcome, "exhausted")
        self.assertEqual(store.song["status"], "awaiting_score")
        self.assertIn("blob download failed", store.song["lastScoreError"])

    def test_song_not_in_parsing_score_is_skipped(self):
        store = FakeStore(_song(status="ready", measureCount=48))

        def _must_not_run(data_dir: Path, song_id: str) -> int:
            raise AssertionError("run_reference must not run for a song that is not parsing_score")

        with tempfile.TemporaryDirectory() as temp:
            outcome = process_score_job(store, _job(), 1, Path(temp), _must_not_run)

        self.assertEqual(outcome, "skipped")
        self.assertEqual(store.patches, [])

    def test_missing_song_is_skipped(self):
        store = FakeStore(None)
        with tempfile.TemporaryDirectory() as temp:
            outcome = process_score_job(store, _job(), 1, Path(temp), _run_reference_ok)
        self.assertEqual(outcome, "skipped")


if __name__ == "__main__":
    unittest.main()
