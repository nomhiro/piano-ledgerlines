from __future__ import annotations

import sys
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker" / "scripts"))

from fetch_checkpoint import fetch_with_retry, is_retryable  # noqa: E402


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://example.invalid", code, "boom", {}, None)


class RetryDecisionTests(unittest.TestCase):
    def test_server_errors_are_retryable(self):
        # 実際に CD を落としたのは Zenodo の 504（2026-08-17 の run 32011026498）。
        for code in (500, 502, 503, 504):
            self.assertTrue(is_retryable(http_error(code)), code)

    def test_rate_limiting_is_retryable(self):
        self.assertTrue(is_retryable(http_error(429)))

    def test_client_errors_are_not_retryable(self):
        # 404 や 403 を待って再試行しても結果は変わらない。URL や公開設定が
        # 変わった場合はビルドを止めて気づかせるほうがよい。
        for code in (400, 403, 404, 410):
            self.assertFalse(is_retryable(http_error(code)), code)

    def test_network_level_failures_are_retryable(self):
        self.assertTrue(is_retryable(urllib.error.URLError("connection reset")))
        self.assertTrue(is_retryable(TimeoutError("timed out")))

    def test_unrelated_errors_are_not_retryable(self):
        self.assertFalse(is_retryable(ValueError("not a network problem")))


class FetchWithRetryTests(unittest.TestCase):
    """`retrieve` / `verify` / `sleep` を差し替えて、ネットワーク無しで検証する。"""

    def setUp(self):
        self.slept: list[float] = []
        self.logs: list[str] = []

    def run_fetch(self, retrieve, verify, attempts=4):
        return fetch_with_retry(
            "https://example.invalid/model.pth",
            Path("/tmp/does-not-matter"),
            attempts=attempts,
            backoff=(1, 2, 3),
            retrieve=retrieve,
            verify=verify,
            sleep=self.slept.append,
            log=self.logs.append,
        )

    def test_success_on_first_attempt_does_not_sleep(self):
        calls: list[int] = []

        def retrieve(url, dest):
            calls.append(1)

        problem = self.run_fetch(retrieve, lambda _dest: None)
        self.assertIsNone(problem)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.slept, [])

    def test_transient_server_error_is_retried_and_can_succeed(self):
        attempts: list[int] = []

        def retrieve(url, dest):
            attempts.append(1)
            if len(attempts) == 1:
                raise http_error(504)

        problem = self.run_fetch(retrieve, lambda _dest: None)
        self.assertIsNone(problem)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.slept, [1])

    def test_backoff_grows_and_reuses_the_last_value(self):
        def retrieve(url, dest):
            raise http_error(504)

        problem = self.run_fetch(retrieve, lambda _dest: None, attempts=5)
        self.assertIsNotNone(problem)
        # 4回の待機（5回目の失敗のあとは待たずに諦める）。backoff は (1,2,3) なので
        # 4回目は最後の値を再利用する。
        self.assertEqual(self.slept, [1, 2, 3, 3])

    def test_client_error_fails_without_retrying(self):
        attempts: list[int] = []

        def retrieve(url, dest):
            attempts.append(1)
            raise http_error(404)

        problem = self.run_fetch(retrieve, lambda _dest: None)
        self.assertIsNotNone(problem)
        self.assertIn("404", problem)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.slept, [])

    def test_verification_failure_is_retried(self):
        # 途中で切れたダウンロードは例外ではなく検証失敗として現れる。
        attempts: list[int] = []

        def retrieve(url, dest):
            attempts.append(1)

        def verify(_dest):
            return None if len(attempts) == 2 else "size 1024 bytes is below the floor"

        problem = self.run_fetch(retrieve, verify)
        self.assertIsNone(problem)
        self.assertEqual(len(attempts), 2)

    def test_verification_failure_after_all_attempts_reports_the_reason(self):
        problem = self.run_fetch(lambda url, dest: None, lambda _dest: "MD5 mismatch", attempts=2)
        self.assertIsNotNone(problem)
        self.assertIn("MD5 mismatch", problem)

    def test_every_retry_is_logged(self):
        def retrieve(url, dest):
            raise http_error(503)

        self.run_fetch(retrieve, lambda _dest: None, attempts=3)
        # ビルドログに残らないと、成功した run が本当は再試行していたことが分からない。
        self.assertEqual(len(self.logs), 2)
        self.assertTrue(all("503" in line for line in self.logs), self.logs)


if __name__ == "__main__":
    unittest.main()
