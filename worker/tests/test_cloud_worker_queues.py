from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

import cloud_worker  # noqa: E402


class QueueNameTests(unittest.TestCase):
    def test_omr_queue_falls_back_to_the_default(self):
        # CD は `az containerapp update --image` だけを行い Bicep を流さないため、
        # AZURE_OMR_QUEUE を持たないリビジョンが動く。required() にすると
        # ワーカーが再起動ループに入り、動いている解析まで落ちる（#33 と同型）。
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AZURE_OMR_QUEUE", None)
            self.assertEqual(cloud_worker.omr_queue_name(), "omr-jobs")

    def test_empty_omr_queue_name_falls_back_too(self):
        with mock.patch.dict(os.environ, {"AZURE_OMR_QUEUE": "   "}):
            self.assertEqual(cloud_worker.omr_queue_name(), "omr-jobs")

    def test_explicit_omr_queue_name_is_used(self):
        with mock.patch.dict(os.environ, {"AZURE_OMR_QUEUE": "omr-jobs-stg"}):
            self.assertEqual(cloud_worker.omr_queue_name(), "omr-jobs-stg")


class FakeQueue:
    def __init__(self, messages=()):
        self.messages = list(messages)
        self.deleted = []

    def receive_messages(self, messages_per_page=1, visibility_timeout=None):
        if not self.messages:
            return iter([])
        return iter([self.messages.pop(0)])

    def delete_message(self, message):
        self.deleted.append(message)


class FakeMessage:
    def __init__(self, content: str, dequeue_count: int = 1):
        self.content = content
        self.dequeue_count = dequeue_count


class DrainOmrQueueTests(unittest.TestCase):
    def test_no_messages_returns_false(self):
        store = mock.Mock()
        store.omr_queue = FakeQueue()
        self.assertFalse(cloud_worker._drain_omr_queue(store, 900))

    def test_processed_message_is_deleted_and_returns_true(self):
        store = mock.Mock()
        message = FakeMessage('{"songId": "song_1", "userId": "usr_1", "jobId": "job_1"}')
        store.omr_queue = FakeQueue([message])
        with mock.patch.object(cloud_worker, "process_omr_job", return_value="completed"):
            self.assertTrue(cloud_worker._drain_omr_queue(store, 900))
        self.assertEqual(store.omr_queue.deleted, [message])

    def test_raised_failure_leaves_the_message(self):
        # process_omr_job は再試行に意味がある失敗だけを送出する。
        store = mock.Mock()
        message = FakeMessage('{"songId": "song_1", "userId": "usr_1"}')
        store.omr_queue = FakeQueue([message])
        with mock.patch.object(cloud_worker, "process_omr_job", side_effect=RuntimeError("boom")):
            self.assertTrue(cloud_worker._drain_omr_queue(store, 900))
        self.assertEqual(store.omr_queue.deleted, [])

    def test_broken_json_does_not_escape(self):
        # songId が読めないメッセージでも例外を外に出さない（ループを止めない）。
        store = mock.Mock()
        store.omr_queue = FakeQueue([FakeMessage("not json")])
        self.assertTrue(cloud_worker._drain_omr_queue(store, 900))


if __name__ == "__main__":
    unittest.main()
