# 楽譜登録を Queue 経由に寄せる 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MusicXML / MXL / MIDI をアップロードした曲が、デプロイ済み Web アプリとローカルのエミュレータプロファイルの両方で `ready` になり、その曲で録音の解析ができる状態にする（Issue #33）。

**Architecture:** 参照譜（`reference.json`）の生成を、Next.js プロセス内の Python spawn から Storage Queue 経由のワーカー処理へ移す。音声解析が既に採っている構造（`analysis-jobs` + `cloud_worker.py`）に揃え、キューだけ `score-jobs` として分ける。API は 202 + `parsing_score` を返し、UI は SSE で `ready` を待つ。

**Tech Stack:** Next.js 16 App Router (Route Handlers) / TypeScript / Node.js `tsx --test` / Python 3.11 + music21 + unittest / Azure Storage Queue・Blob・Cosmos DB / Bicep / Docker Compose (Azurite + Cosmos エミュレータ)

**Spec:** `docs/superpowers/specs/2026-08-16-score-registration-via-queue-design.md`

## Global Constraints

- **Next.js は訓練データと異なる。** コードを書く前に `node_modules/next/dist/docs/` の該当ガイドを読む（`AGENTS.md`）。非推奨の告知に従う。
- キューのメッセージには識別子のみを載せる。音声・トークン・SAS URL を載せない（`src/lib/server/queue.ts:45` の既存の約束）。
- スコアやメタデータを**捏造しない**。測れていない値を `ready` の証跡として書かない（#29 の教訓。本件では `score/complete/route.ts` の `measureCount: 16` を削除する）。
- ワーカーのテストは `cd worker && python tests/test_<name>.py` で実行する（既存6ファイルと同じ unittest 形式）。TypeScript のテストは `npx tsx --test <path>`。
- 参照譜生成の経路は**1本だけ**にする。ローカルバックエンドでも API から見た契約は本番と同一にする（設計 §3.1）。
- **このリポジトリには Route Handler の単体テスト基盤が無い**（既存テストは `src/lib/**` とスクリプトのみ）。したがって設計 §5.2 の「ルートが 202 + enqueue を返すこと」は、ルートの単体テストではなく **(a) 判定ロジックを純関数に切り出して単体テストする（Task 4）+ (b) `scripts/azure-local-smoke.ts` の E2E で status 遷移を検証する（Task 8）** の2段で担保する。ルート専用のテスト基盤を新設することは本計画の範囲外。
- 新しい環境変数の既定値: `AZURE_SCORE_QUEUE=score-jobs`、`WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS=300`。
- 曲ドキュメントの Cosmos パーティションキーは `/userId`（`scripts/azure-local.ts:94`）。

---

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `worker/ledgerlines_worker/score_job.py` | 参照譜ジョブの純ロジック。曲ドキュメントの遷移・成果物のアップロード・メッセージ削除可否だけを決める。**`azure.*` を import しない**ので開発者のホストで単体テストできる |
| `worker/tests/test_score_job.py` | 上記の単体テスト（4ケース） |
| `src/lib/score-progress.ts` | 楽譜登録の進捗の終端判定と失敗文言。SSE ルート（サーバー）とフック（クライアント）が同じ判定を共有する純関数 |
| `src/lib/score-progress.test.ts` | 上記の単体テスト |
| `src/app/api/songs/[songId]/events/route.ts` | 曲の進捗の SSE。`takes/[takeId]/events/route.ts` と同型 |
| `src/lib/hooks/useSongScoreProgress.ts` | EventSource の開閉と状態を1箇所に閉じるクライアントフック |

**変更**

| ファイル | 変更内容 |
|---|---|
| `worker/cloud_worker.py` | `CloudStore` に songs コンテナ・score キュー・楽譜用の Blob 入出力を追加。`main()` が `score-jobs` を優先して受信 |
| `src/lib/server/queue.ts` | `ScoreJob` / `ScoreQueue` / `LocalScoreQueue` / `AzureScoreQueue` / `getScoreQueue()` を追加 |
| `src/lib/server/worker.ts` | `runReferenceWorkerAsync()` を追加 |
| `src/lib/server/config.ts` | `scoreQueueName` を追加 |
| `src/lib/server/observability.ts` | `TelemetryEvent` に `songId?: string` を追加 |
| `src/lib/server/types.ts` / `src/lib/api/client.ts` | `parsing_score` を追加 |
| `src/app/api/songs/[songId]/score/route.ts` | 非 PDF 経路を `parsing_score` + enqueue + 202 に置き換え |
| `src/app/api/songs/[songId]/score/complete/route.ts` | 同上。エミュレータの捏造を削除 |
| `src/app/songs/new/page.tsx` / `src/components/VerifiedScoreReplacement.tsx` | フック経由で `ready` を待つ |
| `infra/main.bicep` / `infra/modules/analysis-worker.bicep` | `score-jobs` と worker の env |
| `docker-compose.azure-local.yml` / `.env.local.azure.example` / `.env.example` / `.env.local.azure-cloud.example` | 同上 |
| `scripts/azure-local.ts` / `scripts/azure-cloud.ts` / `scripts/production-check.ts` | キュー作成・疎通確認・設定の検証 |
| `scripts/azure-local-smoke.ts` | 実在の MusicXML を上げて `ready` を待つ形へ |
| `docs/spec/api.md` / `worker/README.md` | 非同期契約と、回避策の記述の更新 |

**削除**

| ファイル | 理由 |
|---|---|
| `src/lib/server/cloud-score-processing.ts` | Queue に一本化するため経路自体が不要。**`LEDGERLINES_AZURE_CLOUD` フラグ自体は残す**（`azure-credential.ts:10`、`config.ts:162-178`、`scripts/azure-cloud.ts:156` で使用中） |

---

## Task 1: 参照譜ジョブの純ロジック（Python）

**Files:**
- Create: `worker/ledgerlines_worker/score_job.py`
- Test: `worker/tests/test_score_job.py`

**Interfaces:**
- Consumes: `worker_main.run_reference(data_dir: Path, song_id: str) -> int`（既存。呼び出し側から注入するのでこのモジュールは import しない）
- Produces:
  - `process_score_job(store, job: dict, dequeue_count: int, work_dir: Path, run_reference: Callable[[Path, str], int]) -> str` — 戻り値は `"completed"` / `"failed"` / `"skipped"` / `"exhausted"`。いずれもメッセージ削除可。再試行させたいときは例外を投げる
  - `MAX_ATTEMPTS: int = 3`
  - `ScoreStore` プロトコル: `get_song(song_id, user_id) -> dict | None` / `update_song(song_id, user_id, patch) -> Any` / `download_score(song, target_dir) -> Path` / `upload_reference(song, source) -> None` / `upload_preview(song, file_name, source) -> None`

**背景（実装者向け）**

`run_reference` はファイルシステム上のデータディレクトリを前提に動く既存関数で、次の入出力を持つ（`worker/worker_main.py:144-202`）。

- 読む: `<data_dir>/songs/<songId>.json`、`<data_dir>/scores/<songId>/score.*`
- 書く: `<data_dir>/derived/<songId>/reference.json`、`<data_dir>/scores/<songId>/preview.musicxml`（`.mxl` 入力のとき）、`<data_dir>/scores/<songId>/preview.mid`、更新後の `songs/<songId>.json`
- 戻り値: 成功 `0` / パース失敗 `1`（このとき曲 JSON に `status: "awaiting_score"` と `lastScoreError` を書いている）

`.musicxml` / `.xml` 入力では `materialize_preview_score` が入力ファイル自身を返すため、`previewScoreFileName` は `score.musicxml` になる（`preview.musicxml` ではない）。したがってプレビューのアップロードは**曲 JSON に書かれたファイル名をそのまま使う**こと。決め打ちしてはいけない。

- [ ] **Step 1: 失敗するテストを書く**

`worker/tests/test_score_job.py`

```python
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
```

- [ ] **Step 2: 失敗することを確認する**

Run: `cd worker && python tests/test_score_job.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'ledgerlines_worker.score_job'`

- [ ] **Step 3: 実装する**

`worker/ledgerlines_worker/score_job.py`

```python
"""参照譜生成ジョブの純ロジック（Azure SDK に依存しない）。

cloud_worker.py がキューの受信とストア実装（Blob / Cosmos）を担い、この
モジュールは「曲ドキュメントをどう遷移させ、どの成果物を上げ、メッセージを
削除してよいか」だけを決める。azure.* を import しないので、ワーカーイメージ
以外（開発者のホスト）でも単体テストが動く。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Protocol

# 曲が永久に parsing_score のまま残るのを防ぐための試行上限。
# 想定しているのは Blob / Cosmos 側の一時的な失敗で、これは再試行に意味がある。
# 楽譜そのものが壊れている場合は run_reference が終了コード1で戻るため、
# 1回目で awaiting_score に落として終端させる（下の "failed" 分岐）。
MAX_ATTEMPTS = 3

# 参照譜生成が確定させる曲ドキュメントのフィールド。
# src/lib/server/cloud-score-processing.ts:58-69 と同じ集合。
RESULT_FIELDS = (
    "measureCount",
    "scoreMeasureCount",
    "keySignature",
    "timeSignature",
    "detectedTempo",
    "hasRepeats",
    "warnings",
    "previewScoreFileName",
    "previewMidiFileName",
)


class ScoreStore(Protocol):
    def get_song(self, song_id: str, user_id: str) -> dict[str, Any] | None: ...

    # 戻り値は使わないが、CloudStore.update_song は既存の update_take に倣って
    # 更新後のドキュメントを返すため Any にしておく。
    def update_song(self, song_id: str, user_id: str, patch: dict[str, Any]) -> Any: ...

    def download_score(self, song: dict[str, Any], target_dir: Path) -> Path: ...

    def upload_reference(self, song: dict[str, Any], source: Path) -> None: ...

    def upload_preview(self, song: dict[str, Any], file_name: str, source: Path) -> None: ...


def process_score_job(
    store: ScoreStore,
    job: dict[str, Any],
    dequeue_count: int,
    work_dir: Path,
    run_reference: Callable[[Path, str], int],
) -> str:
    """参照譜を生成し、曲を ready / awaiting_score へ遷移させる。

    戻り値は呼び出し側がメッセージを削除してよいかの判断に使う。
    "completed" / "failed" / "skipped" / "exhausted" はいずれも削除してよい。
    再配信させたい失敗は例外として送出する（メッセージを残す）。
    """
    song_id = job["songId"]
    user_id = job["userId"]
    song = store.get_song(song_id, user_id)
    if song is None:
        return "skipped"
    if song.get("status") != "parsing_score":
        # 再配信の重複か、ユーザーが楽譜を差し替えて別のジョブが処理済み。
        # 完了済みの曲を作り直して warnings を書き戻すのは害にしかならない。
        return "skipped"

    try:
        score_path = _materialize_inputs(store, song, work_dir)
        code = run_reference(work_dir, song_id)
        parsed = json.loads(
            (work_dir / "songs" / f"{song_id}.json").read_text(encoding="utf-8")
        )
    except Exception as exc:  # noqa: BLE001
        if dequeue_count >= MAX_ATTEMPTS:
            store.update_song(
                song_id,
                user_id,
                {"status": "awaiting_score", "lastScoreError": str(exc)},
            )
            return "exhausted"
        raise

    if code != 0 or parsed.get("status") != "ready":
        store.update_song(
            song_id,
            user_id,
            {
                "status": "awaiting_score",
                "lastScoreError": parsed.get("lastScoreError") or "score parsing failed",
            },
        )
        return "failed"

    store.upload_reference(song, work_dir / "derived" / song_id / "reference.json")
    # プレビューのファイル名は run_reference が決める（.musicxml 入力では入力
    # ファイル自身が使われ score.musicxml になる）。決め打ちしてはいけない。
    for file_name in (parsed.get("previewScoreFileName"), parsed.get("previewMidiFileName")):
        if file_name:
            store.upload_preview(song, file_name, score_path.parent / file_name)

    store.update_song(
        song_id,
        user_id,
        {
            "status": "ready",
            "lastScoreError": None,
            **{key: parsed.get(key) for key in RESULT_FIELDS},
        },
    )
    return "completed"


def _materialize_inputs(store: ScoreStore, song: dict[str, Any], work_dir: Path) -> Path:
    """run_reference が期待するファイルレイアウトを一時領域に用意する。"""
    songs_dir = work_dir / "songs"
    songs_dir.mkdir(parents=True, exist_ok=True)
    (songs_dir / f"{song['id']}.json").write_text(
        json.dumps(song, ensure_ascii=False), encoding="utf-8"
    )
    score_dir = work_dir / "scores" / song["id"]
    score_dir.mkdir(parents=True, exist_ok=True)
    return store.download_score(song, score_dir)
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd worker && python tests/test_score_job.py`
Expected: PASS（5テスト、`OK`）

- [ ] **Step 5: コミット**

```bash
git add worker/ledgerlines_worker/score_job.py worker/tests/test_score_job.py
git commit -m "feat: add the score reference job logic as an azure-free module"
```

---

## Task 2: cloud_worker.py に songs コンテナと score キューを配線する

**Files:**
- Modify: `worker/cloud_worker.py`（`CloudStore.__init__` 71-115、`main()` 235-256）

**Interfaces:**
- Consumes: `process_score_job` / `MAX_ATTEMPTS`（Task 1）、`worker_main.run_reference`
- Produces: `CloudStore` が `ScoreStore` プロトコルを満たす（`get_song` / `update_song` / `download_score` / `upload_reference` / `upload_preview`）、`CloudStore.score_queue`、`_drain_score_queue(store, visibility_seconds) -> bool`

**注意:** `cloud_worker.py` は `azure.*` を import するため、開発者のホストに Azure SDK が無いと import できない。このタスクの検証はワーカーコンテナ内の import チェックで行う（Step 4）。ロジックの単体テストは Task 1 側に置いてある。

- [ ] **Step 1: import と CloudStore を拡張する**

`worker/cloud_worker.py` の import に追加する。

```python
from ledgerlines_worker.score_job import MAX_ATTEMPTS, process_score_job
from worker_main import run_analyze, run_reference
```

`CloudStore.__init__` のエミュレータ分岐（`self.queue = QueueClient.from_connection_string(...)` の直後）に score キューを追加する。

```python
            self.score_queue = QueueClient.from_connection_string(
                connection_string,
                required("AZURE_SCORE_QUEUE"),
            )
```

本番分岐（`self.queue = QueueClient(...)` の直後）にも追加する。

```python
            self.score_queue = QueueClient(
                account_url=self.queue_url,
                queue_name=required("AZURE_SCORE_QUEUE"),
                credential=credential,
            )
```

コンテナの取得部（`self.takes = ...` の並び）に songs を追加する。

```python
        self.songs = database.get_container_client(os.environ.get("AZURE_COSMOS_SONGS_CONTAINER", "songs"))
```

- [ ] **Step 2: 曲ドキュメントと楽譜 Blob の入出力を追加する**

`CloudStore` に以下のメソッドを追加する（既存の `get_take` / `update_take` / `upload` の直後）。

```python
    def get_song(self, song_id: str, user_id: str) -> dict[str, Any] | None:
        try:
            return self.songs.read_item(item=song_id, partition_key=user_id)
        except ResourceNotFoundError:
            return None

    def update_song(self, song_id: str, user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self.get_song(song_id, user_id)
        if current is None:
            raise RuntimeError(f"song {song_id} not found")
        current.update(patch)
        current["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return self.songs.replace_item(item=song_id, body=current)

    def download_score(self, song: dict[str, Any], target_dir: Path) -> Path:
        # Blob 名は src/lib/server/cloud-score-processing.ts:10-13 と同一。
        # 拡張子は曲ドキュメントの scoreFileName から引く（アップロード時に
        # 検証済みの拡張子がそのまま入っている）。
        extension = Path(song.get("scoreFileName") or "").suffix.lower() or ".musicxml"
        name = f"users/{song['userId']}/songs/{song['id']}/scores/score{extension}"
        target = target_dir / f"score{extension}"
        target.write_bytes(self.scores.download_blob(name).readall())
        return target

    def upload_reference(self, song: dict[str, Any], source: Path) -> None:
        self.upload(
            self.derived,
            f"users/{song['userId']}/songs/{song['id']}/reference.json",
            source,
            "application/json",
        )

    def upload_preview(self, song: dict[str, Any], file_name: str, source: Path) -> None:
        content_type = (
            "audio/midi" if file_name.lower().endswith(".mid")
            else "application/vnd.recordare.musicxml+xml"
        )
        self.upload(
            self.scores,
            f"users/{song['userId']}/songs/{song['id']}/scores/{file_name}",
            source,
            content_type,
        )
```

- [ ] **Step 3: score キューを優先して受信する**

`process_job` の下に追加する。

```python
def _drain_score_queue(store: CloudStore, visibility_seconds: int) -> bool:
    """score-jobs を1件処理する。処理したら True（呼び出し側が先頭から見直す）。"""
    messages = list(
        store.score_queue.receive_messages(messages_per_page=1, visibility_timeout=visibility_seconds)
    )
    if not messages:
        return False
    for message in messages:
        try:
            job = json.loads(message.content)
            with tempfile.TemporaryDirectory(prefix=f"ledgerlines-score-{job['songId']}-") as temp:
                outcome = process_score_job(
                    store, job, message.dequeue_count, Path(temp), run_reference
                )
            store.score_queue.delete_message(message)
            LOGGER.info("Score job %s outcome=%s song=%s", job.get("jobId"), outcome, job.get("songId"))
        except Exception:
            # process_score_job は再試行に意味がある失敗だけを送出する
            # （MAX_ATTEMPTS 到達時は自分で終端させて戻る）。
            LOGGER.exception("Score job failed; leaving message for retry (max %s attempts)", MAX_ATTEMPTS)
    return True
```

`main()` を次の形にする。

```python
def main() -> None:
    store = CloudStore()
    polling_seconds = int(os.environ.get("WORKER_POLLING_SECONDS", "5"))
    visibility_seconds = int(os.environ.get("WORKER_VISIBILITY_TIMEOUT_SECONDS", "1800"))
    score_visibility_seconds = int(os.environ.get("WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS", "300"))
    LOGGER.info("Analysis worker started")
    while True:
        # 参照譜生成（数秒）を解析（数分）より先に見る。ただしレプリカは1つで
        # ループも1本なので、既に走っている解析を追い越すことはできない
        # （設計 §4.2 の既知の制約）。
        if _drain_score_queue(store, score_visibility_seconds):
            continue
        messages = list(store.queue.receive_messages(messages_per_page=1, visibility_timeout=visibility_seconds))
        if not messages:
            time.sleep(polling_seconds)
            continue
        for message in messages:
            try:
                job = json.loads(message.content)
                process_job(store, job)
                store.queue.delete_message(message)
                LOGGER.info("Completed analysis job %s", job.get("jobId"))
            except Exception:
                LOGGER.exception("Analysis job failed; leaving message for retry")
```

- [ ] **Step 4: 構文と import を確認する**

Run: `cd worker && python -c "import ast,pathlib; ast.parse(pathlib.Path('cloud_worker.py').read_text(encoding='utf-8')); print('syntax ok')"`
Expected: `syntax ok`

Run: `cd worker && python tests/test_score_job.py`
Expected: PASS（Task 1 のテストが壊れていないこと）

`azure.*` が入った環境での import 確認は Task 3 でキューの env を用意した後に行う（`npm run azure:up` 後に `docker compose -f docker-compose.azure-local.yml exec worker python -c "import cloud_worker"`）。この時点では構文チェックまでで先へ進む。

- [ ] **Step 5: コミット**

```bash
git add worker/cloud_worker.py
git commit -m "feat: consume score-jobs in the cloud worker"
```

---

## Task 3: `score-jobs` を infra と設定に追加する

**Files:**
- Modify: `infra/main.bicep:83-85`（`queues`）、`infra/main.bicep:270-280`（worker モジュールの引数）
- Modify: `infra/modules/analysis-worker.bicep:19-28`（param）、`:54-66`（env）
- Modify: `docker-compose.azure-local.yml:65-81`（worker env）
- Modify: `.env.local.azure.example:38` 付近、`.env.example:19` 付近、`.env.local.azure-cloud.example:24` 付近
- Modify: `scripts/azure-local.ts:115-117`（キュー作成）
- Modify: `scripts/azure-cloud.ts:118-125`（env マッピング）、`:220-230`（疎通確認）
- Modify: `src/lib/server/config.ts:38` 付近（型）、`:138` 付近（値）
- Modify: `scripts/production-check.ts`（既定値の検証を追加）

**Interfaces:**
- Consumes: なし
- Produces: `AppConfig.scoreQueueName: string`（既定 `"score-jobs"`）、環境変数 `AZURE_SCORE_QUEUE`、`WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS`

- [ ] **Step 1: 失敗するテストを書く**

`scripts/production-check.ts` の `test("production rejects emulator and local cloud profiles")`（`:308-338`）の直後に追記する。`getConfig` と `resetConfigForTests` は同ファイルで既に import 済みなので、追加の import は不要。

```ts
test("score queue name defaults to score-jobs and is overridable", () => {
  const previous = process.env.AZURE_SCORE_QUEUE;
  delete process.env.AZURE_SCORE_QUEUE;
  resetConfigForTests();
  assert.equal(getConfig().scoreQueueName, "score-jobs");

  process.env.AZURE_SCORE_QUEUE = "score-jobs-test";
  resetConfigForTests();
  assert.equal(getConfig().scoreQueueName, "score-jobs-test");

  if (previous === undefined) delete process.env.AZURE_SCORE_QUEUE;
  else process.env.AZURE_SCORE_QUEUE = previous;
  resetConfigForTests();
});
```

環境変数を書き換えたら必ず `resetConfigForTests()`（`src/lib/server/config.ts:221`）で設定キャッシュを捨てる。既存テストと同じ「保存 → 変更 → 検証 → 復元 → reset」の順を守ること。

- [ ] **Step 2: 失敗することを確認する**

Run: `npm run test:production`
Expected: FAIL — `scoreQueueName` が `undefined`（型エラーまたは assert 失敗）

- [ ] **Step 3: 設定と infra を実装する**

`src/lib/server/config.ts` の `AppConfig` に追加する。

```ts
  scoreQueueName: string;
```

`config` オブジェクトの `analysisQueueName` の直後に追加する。

```ts
    scoreQueueName: process.env.AZURE_SCORE_QUEUE ?? "score-jobs",
```

`infra/main.bicep` の `queues`:

```bicep
var queues = [
  'analysis-jobs'
  'score-jobs'
]
```

worker モジュールの呼び出し（`:265-289`）に引数を渡す。`analysisQueueName: 'analysis-jobs'`（`:277`）の直後、および `takesContainerName: 'takes'`（`:282`）の直後に並べる。

```bicep
    scoreQueueName: 'score-jobs'
    songsContainerName: 'songs'
    scoresContainerName: 'scores'
```

**RBAC の追加は不要**（確認済み）。`infra/modules/rbac.bicep` は worker の Managed Identity に
Blob Data Contributor と Queue Processor を **`scope: storageAccount`**（アカウント全体、`:52-79`）で、
Cosmos Data Contributor を **アカウントスコープ**（`:112-119`）で割り当てている。したがって
scores コンテナの読み書き、songs コンテナの読み書き、`score-jobs` の受信はいずれも既存の付与で足りる。

`infra/modules/analysis-worker.bicep` に param を追加する。

```bicep
param scoreQueueName string
param songsContainerName string
```

env に追加する（`AZURE_ANALYSIS_QUEUE` の直後）。

```bicep
            { name: 'AZURE_SCORE_QUEUE', value: scoreQueueName }
            { name: 'AZURE_COSMOS_SONGS_CONTAINER', value: songsContainerName }
            { name: 'AZURE_STORAGE_SCORES_CONTAINER', value: scoresContainerName }
            { name: 'WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS', value: '300' }
```

`scoresContainerName` は既存 param に無いので、`audioContainerName` と同じ形で param を追加し、`main.bicep` から `'scores'` を渡す。

`docker-compose.azure-local.yml` の worker env に追加する。

```yaml
      AZURE_COSMOS_SONGS_CONTAINER: songs
      AZURE_SCORE_QUEUE: score-jobs
      WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS: "300"
```

`scripts/azure-local.ts` のキュー作成を2本にする。

```ts
  const queueService = QueueServiceClient.fromConnectionString(connection);
  for (const name of [
    process.env.AZURE_ANALYSIS_QUEUE ?? "analysis-jobs",
    process.env.AZURE_SCORE_QUEUE ?? "score-jobs",
  ]) await queueService.getQueueClient(name).createIfNotExists();
```

`.env.local.azure.example` に `AZURE_ANALYSIS_QUEUE=analysis-jobs` の隣へ追加する。

```
AZURE_SCORE_QUEUE=score-jobs
```

`.env.example` と `.env.local.azure-cloud.example` にはコメント行として追加する（既存の `# AZURE_ANALYSIS_QUEUE=analysis-jobs` と同じ形）。

```
# AZURE_SCORE_QUEUE=score-jobs
```

`scripts/azure-cloud.ts` の env マッピングと疎通確認に `score-jobs` を追加する。`AZURE_ANALYSIS_QUEUE` / `analysisQueueName` を扱っている2箇所（`:120`、`:223-224`）と同じ形で、`AZURE_SCORE_QUEUE` / `scoreQueueName` を並べる。疎通確認は既存の `check(\`Storage Queue ${config.analysisQueueName}\`, ...)` を2回呼ぶ形にする。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm run test:production`
Expected: PASS

Run: `npx tsc --noEmit && npm run lint`
Expected: どちらも出力なし

- [ ] **Step 5: エミュレータでキューが作られ、ワーカーが import できることを確認する**

```bash
npm run azure:up
npm run azure:init
docker compose -f docker-compose.azure-local.yml exec worker python -c "import cloud_worker; print('import ok')"
```

Expected: `import ok`（Task 2 の配線が実 SDK で成立していること）。ワーカーのログに `QueueNotFound` が数回出るのは既知（`worker/README.md:92-95`）。

- [ ] **Step 6: コミット**

```bash
git add infra src/lib/server/config.ts scripts docker-compose.azure-local.yml .env.example .env.local.azure.example .env.local.azure-cloud.example
git commit -m "feat: provision the score-jobs queue and wire it into every profile"
```

---

## Task 4: `parsing_score` ステータスと進捗の終端判定

**Files:**
- Modify: `src/lib/server/types.ts:9`
- Modify: `src/lib/api/client.ts:10`
- Create: `src/lib/score-progress.ts`
- Test: `src/lib/score-progress.test.ts`
- Modify: `package.json`（`test:unit` の対象に追加）

**Interfaces:**
- Consumes: `SongDocStatus`（`src/lib/server/types.ts`）
- Produces:
  - `isScoreProgressTerminal(status: SongDocStatus): boolean`
  - `scoreProgressFailureMessage(song: { status: SongDocStatus; lastScoreError?: string | null; omrError?: string | null }): string | null` — 失敗でなければ `null`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/score-progress.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { isScoreProgressTerminal, scoreProgressFailureMessage } from "./score-progress";

test("parsing_score keeps the stream open", () => {
  assert.equal(isScoreProgressTerminal("parsing_score"), false);
});

test("ready ends the stream", () => {
  assert.equal(isScoreProgressTerminal("ready"), true);
});

test("awaiting_score ends the stream because generation already failed", () => {
  assert.equal(isScoreProgressTerminal("awaiting_score"), true);
});

test("reviewing_score ends the stream because it waits on the user", () => {
  assert.equal(isScoreProgressTerminal("reviewing_score"), true);
});

test("omr_failed ends the stream", () => {
  assert.equal(isScoreProgressTerminal("omr_failed"), true);
});

test("converting_score keeps the stream open until the cap", () => {
  // PDF の OMR は本設計のスコープ外で、azure バックエンドでは進まない。
  // 終端扱いにすると「変換中」を失敗として見せてしまうので、上限打ち切りに任せる。
  assert.equal(isScoreProgressTerminal("converting_score"), false);
});

test("failure message prefers the worker's reason", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "awaiting_score", lastScoreError: "小節線が閉じていません" }),
    "小節線が閉じていません",
  );
});

test("failure message falls back when the worker left no reason", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "awaiting_score" }),
    "楽譜を解析できませんでした。ファイルを確認して、もう一度アップロードしてください。",
  );
});

test("failure message uses omrError for a failed PDF conversion", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "omr_failed", omrError: "PDFを変換できませんでした" }),
    "PDFを変換できませんでした",
  );
});

test("ready has no failure message", () => {
  assert.equal(scoreProgressFailureMessage({ status: "ready" }), null);
});
```

- [ ] **Step 2: 失敗することを確認する**

Run: `npx tsx --test src/lib/score-progress.test.ts`
Expected: FAIL — `Cannot find module './score-progress'`

- [ ] **Step 3: 実装する**

`src/lib/server/types.ts:9` を差し替える。

```ts
export type SongDocStatus =
  | "awaiting_score"
  | "parsing_score"
  | "converting_score"
  | "reviewing_score"
  | "omr_failed"
  | "ready";
```

`src/lib/api/client.ts:10` の `ApiSong["status"]` も同じ集合に揃える。

```ts
  status: "awaiting_score" | "parsing_score" | "converting_score" | "reviewing_score" | "omr_failed" | "ready";
```

`src/lib/score-progress.ts`

```ts
// 楽譜登録の進捗をどこで打ち切るかの判定。SSE ルート（サーバー）と
// useSongScoreProgress（クライアント）の両方が同じ判定を使うため、DOM にも
// Node の API にも依存しない純関数として1箇所に置く。
import type { SongDocStatus } from "@/lib/server/types";

const FALLBACK_FAILURE_MESSAGE =
  "楽譜を解析できませんでした。ファイルを確認して、もう一度アップロードしてください。";

/**
 * 待っても変化しない状態。SSE はここで done を送って閉じる。
 *
 * - `parsing_score` はワーカーが生成中なので待つ
 * - `awaiting_score` は「生成が失敗して戻された」状態。登録直後は必ず
 *   `parsing_score` から始まるため、待機中にこれを見たら失敗である
 * - `reviewing_score` はユーザーがドラフトを承認するまで進まない
 * - `converting_score`（PDF の OMR 実行中）は本設計のスコープ外で、azure
 *   バックエンドでは誰も処理しない。失敗と見せないため終端にはせず、
 *   ストリームの時間上限に任せる
 */
export function isScoreProgressTerminal(status: SongDocStatus): boolean {
  return (
    status === "ready" ||
    status === "awaiting_score" ||
    status === "reviewing_score" ||
    status === "omr_failed"
  );
}

/** 失敗しているときだけユーザー向けの理由を返す。 */
export function scoreProgressFailureMessage(song: {
  status: SongDocStatus;
  lastScoreError?: string | null;
  omrError?: string | null;
}): string | null {
  if (song.status === "omr_failed") return song.omrError || FALLBACK_FAILURE_MESSAGE;
  if (song.status === "awaiting_score") return song.lastScoreError || FALLBACK_FAILURE_MESSAGE;
  return null;
}
```

`package.json` の `test:unit` に追加する。

```json
    "test:unit": "tsx --test src/components/score-overlay.test.ts src/lib/score-progress.test.ts src/lib/real-history.test.ts",
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm run test:unit`
Expected: PASS（既存13件 + 新規10件 = 23件）

Run: `npx tsc --noEmit`
Expected: 出力なし（`parsing_score` の追加で網羅性チェックが壊れる箇所があればここで出る。出たら該当の分岐に `parsing_score` を追加する）

- [ ] **Step 5: コミット**

```bash
git add src/lib/server/types.ts src/lib/api/client.ts src/lib/score-progress.ts src/lib/score-progress.test.ts package.json
git commit -m "feat: add the parsing_score status and score progress predicates"
```

---

## Task 5: TypeScript 側の `ScoreQueue`

**Files:**
- Modify: `src/lib/server/queue.ts`（末尾に追加）
- Modify: `src/lib/server/worker.ts`（`runReferenceWorkerAsync` を追加）
- Modify: `src/lib/server/observability.ts:3-15`（`songId` を追加）
- Modify: `scripts/production-check.ts`（バックエンド選択の検証を追加）

**Interfaces:**
- Consumes: `AppConfig.scoreQueueName`（Task 3）
- Produces:
  - `ScoreJob { schemaVersion: 1; jobId: string; songId: string; userId: string; attempt: number; correlationId: string }`
  - `ScoreQueue { enqueue(job: ScoreJob): Promise<void> }`
  - `getScoreQueue(): ScoreQueue` / `resetScoreQueueForTests(): void`
  - `runReferenceWorkerAsync(songId: string): void`

- [ ] **Step 1: 失敗するテストを書く**

`scripts/production-check.ts` に追記する。

```ts
test("score queue backend follows LEDGERLINES_QUEUE", async () => {
  const { getScoreQueue, resetScoreQueueForTests, AzureScoreQueue, LocalScoreQueue } =
    await import("../src/lib/server/queue");
  const previous = process.env.LEDGERLINES_QUEUE;

  process.env.LEDGERLINES_QUEUE = "local";
  resetConfigForTests();
  resetScoreQueueForTests();
  assert.ok(getScoreQueue() instanceof LocalScoreQueue);

  if (previous === undefined) delete process.env.LEDGERLINES_QUEUE;
  else process.env.LEDGERLINES_QUEUE = previous;
  resetConfigForTests();
  resetScoreQueueForTests();
  assert.ok(AzureScoreQueue);
});
```

`AzureScoreQueue` はコンストラクタで実 Queue クライアントを作るため、ここでは**存在の確認だけ**にする（`azure` バックエンドの実際の送信は Task 8 のスモークで確認する）。

- [ ] **Step 2: 失敗することを確認する**

Run: `npm run test:production`
Expected: FAIL — `getScoreQueue` が `queue.ts` に存在しない

- [ ] **Step 3: 実装する**

`src/lib/server/observability.ts` の `TelemetryEvent` に追加する。

```ts
  songId?: string;
```

`src/lib/server/worker.ts` の末尾に追加する。

```ts
/**
 * 参照譜生成をローカルバックエンドで非同期に走らせる。api.md 5.1 は 202 +
 * 進捗の購読が前提になったため（Issue #33）、呼び出し元は await しない。
 * songs/{songId}.json の status をワーカーが直接更新するので、進捗は
 * ファイルをポーリングして把握する（analyze と同じ考え方）。
 */
export function runReferenceWorkerAsync(songId: string): void {
  runWorker(["--mode", "reference", "--data-dir", DATA_DIR, "--song-id", songId]).catch((err) => {
    console.error(`[worker] reference failed to start for song ${songId}:`, err);
  });
}
```

`src/lib/server/queue.ts` の末尾（`resetAnalysisQueueForTests` の後）に追加する。

```ts
export interface ScoreJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  userId: string;
  attempt: number;
  correlationId: string;
}

export interface ScoreQueue {
  enqueue(job: ScoreJob): Promise<void>;
}

export class LocalScoreQueue implements ScoreQueue {
  async enqueue(job: ScoreJob): Promise<void> {
    // プロセス spawn の実装はローカルバックエンドの内側に閉じる。API から見た
    // 契約（202 を返して進捗は別途購読する）は本番と同一にする。
    const { runReferenceWorkerAsync } = await import("./worker");
    runReferenceWorkerAsync(job.songId);
    getTelemetry().record({ name: "score.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "local" });
  }
}

export class AzureScoreQueue implements ScoreQueue {
  private readonly client: QueueClient;

  constructor() {
    const config = getConfig();
    this.client = config.azureEmulator
      ? QueueServiceClient.fromConnectionString(config.storageConnectionString!).getQueueClient(config.scoreQueueName)
      : new QueueClient(
          `${config.storageQueueUrl ?? config.storageAccountUrl}/${config.scoreQueueName}`,
          createAzureCredential()
        );
  }

  async enqueue(job: ScoreJob): Promise<void> {
    // 解析ジョブと同じ約束: メッセージは識別子だけを載せる。
    await this.client.sendMessage(JSON.stringify(job));
    getTelemetry().record({ name: "score.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "azure" });
  }
}

let scoreQueue: ScoreQueue | undefined;
export function getScoreQueue(): ScoreQueue {
  scoreQueue ??= getConfig().queueBackend === "azure" ? new AzureScoreQueue() : new LocalScoreQueue();
  return scoreQueue;
}

export function resetScoreQueueForTests(): void {
  scoreQueue = undefined;
}
```

`AzureAnalysisQueue` にある `runDeterministicAnalysis` 相当の分岐は**入れない**。決定論的スタブは解析（音声が要る）のためのもので、参照譜生成はエミュレータでもワーカーが本物を生成できる。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm run test:production`
Expected: PASS

Run: `npx tsc --noEmit && npm run lint`
Expected: どちらも出力なし

- [ ] **Step 5: コミット**

```bash
git add src/lib/server/queue.ts src/lib/server/worker.ts src/lib/server/observability.ts scripts/production-check.ts
git commit -m "feat: add a score queue alongside the analysis queue"
```

---

## Task 6: API ルートを enqueue に切り替え、同期経路を削除する

**Files:**
- Modify: `src/app/api/songs/[songId]/score/route.ts:64-94`
- Modify: `src/app/api/songs/[songId]/score/complete/route.ts:29-41`
- Delete: `src/lib/server/cloud-score-processing.ts`

**Interfaces:**
- Consumes: `getScoreQueue()` / `ScoreJob`（Task 5）、`parsing_score`（Task 4）
- Produces: `POST /api/songs/{songId}/score` と `.../score/complete` が 202 `{ songId, status: "parsing_score", uploadComplete: true }` を返す

**注意:** このタスク単体では UI がまだ待たないため、登録画面は「楽譜を受け付けました」で止まり、`VerifiedScoreReplacement` は「楽譜を解析できませんでした」を出す。Task 7 と必ず同じ PR で入れる。

- [ ] **Step 1: 非 PDF 経路を差し替える**

`src/app/api/songs/[songId]/score/route.ts` の import を修正する。

```ts
import { randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong, saveScoreFile, updateSong } from "@/lib/server/repository";
import { runOmrWorker } from "@/lib/server/worker";
import { getScoreQueue } from "@/lib/server/queue";
```

`runReferenceWorker` と `processCloudScoreLocally` の import を削除する（`runOmrWorker` は PDF 経路が使うので残す）。

`:64-94`（`await updateSong(...)` から関数末尾の `jsonResponse` まで）を次に置き換える。

```ts
    await updateSong(songId, {
      status: "parsing_score",
      scoreSource: ext === ".mid" || ext === ".midi" ? "midi" : "musicxml",
      sourceScoreFileName: file.name,
      omrEngine: null,
      omrError: undefined,
      lastScoreError: undefined,
    }, user.id);
    await getScoreQueue().enqueue({
      schemaVersion: 1,
      jobId: randomUUID(),
      songId,
      userId: user.id,
      attempt: 1,
      correlationId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    // 参照譜の生成はワーカーが行う（Issue #33）。ストレージバックエンドで分岐しない ──
    // ローカルでしか通らない経路を作らないことが、この変更の目的そのもの。
    return jsonResponse({ songId, status: "parsing_score", uploadComplete: true }, request, { status: 202 });
```

`getConfig` は PDF 経路（`:51`）が使い続けるので import に残す。

- [ ] **Step 2: SAS 完了通知を差し替える**

`src/app/api/songs/[songId]/score/complete/route.ts` の `:29-41` を次に置き換える。

```ts
    await updateSong(songId, { status: "parsing_score", lastScoreError: undefined }, user.id);
    await getScoreQueue().enqueue({
      schemaVersion: 1,
      jobId: randomUUID(),
      songId,
      userId: user.id,
      attempt: 1,
      correlationId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    return jsonResponse({ songId, status: "parsing_score", uploadComplete: true }, request, { status: 202 });
```

import に `randomUUID`（`node:crypto`）と `getScoreQueue` を追加する。

**エミュレータ分岐（`measureCount: 16` / `detectedTempo: 96` を書いて `ready` にしていた箇所）は完全に削除する。** 参照譜が無いのに `ready` を名乗る状態を作らないため（設計 §2.4）。

- [ ] **Step 3: 同期経路を削除する**

```bash
git rm src/lib/server/cloud-score-processing.ts
```

- [ ] **Step 4: 参照が残っていないことを確認する**

Run: `npx tsc --noEmit && npm run lint`
Expected: どちらも出力なし

Run: `git grep -n "processCloudScoreLocally\|cloud-score-processing" -- src scripts`
Expected: 出力なし

Run: `git grep -n "runReferenceWorker\b" -- src`
Expected: `src/lib/server/worker.ts` の定義だけが出る（呼び出し側は `runReferenceWorkerAsync` のみ）

Run: `npm run test:production && npm run test:unit`
Expected: どちらも PASS

- [ ] **Step 5: コミット**

```bash
git add src/app/api/songs
git commit -m "feat: enqueue reference generation instead of running python in-process"
```

---

## Task 7: 進捗の SSE とそれを待つ UI

**Files:**
- Create: `src/app/api/songs/[songId]/events/route.ts`
- Create: `src/lib/hooks/useSongScoreProgress.ts`
- Modify: `src/app/songs/new/page.tsx:10`（`Phase`）、`:60-92`（`handleFile`）、`:213-217`（`awaiting_score` の表示）
- Modify: `src/components/VerifiedScoreReplacement.tsx:13-29`

**Interfaces:**
- Consumes: `isScoreProgressTerminal` / `scoreProgressFailureMessage`（Task 4）、`GET /api/songs/{songId}`（既存）
- Produces:
  - `GET /api/songs/{songId}/events` — SSE。`status` イベントで `{ status, measureCount, scoreMeasureCount, keySignature, timeSignature, detectedTempo, warnings, failureMessage }`、終端で `done`
  - `useSongScoreProgress(songId: string | null): { status: SongDocStatus | null; info: ScoreInfo | null; failureMessage: string | null }`
  - `ScoreInfo { measureCount: number; timeSignature: string; keySignature: string; detectedTempo: number; warnings: { code: string; message: string }[] }`

- [ ] **Step 1: SSE ルートを実装する**

`src/app/api/songs/[songId]/events/route.ts`

```ts
import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, requestId, NotFoundError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong } from "@/lib/server/repository";
import { isScoreProgressTerminal, scoreProgressFailureMessage } from "@/lib/score-progress";

export const runtime = "nodejs";

// takes/[takeId]/events/route.ts と同じ形。
//
// これは真の push ではない ── サーバー側で1秒ごとに曲ドキュメントを読み、その結果を
// SSE として流している。したがって Cosmos の読み取り回数はクライアントポーリングと
// 同じで、削減はしていない。利点は「クライアントが1接続で待てる」ことだけである。
// 真の push にするには Cosmos change feed に加えてブラウザへの配信経路
// (Web PubSub / SignalR) が必要になる。今の規模（登録は1回数秒〜数分、同時待機は
// ごく少数）では過剰と判断した（設計 §4.5）。
const POLL_INTERVAL_MS = 1000;
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    if (!(await getSong(songId, user.id))) throw new NotFoundError("song not found");
    const lastEvent = Number(request.headers.get("last-event-id") ?? "0");
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const startedAt = Date.now();
        let eventId = Number.isFinite(lastEvent) ? lastEvent : 0;
        let closed = false;
        const send = (event: string, data: unknown) => {
          eventId += 1;
          controller.enqueue(encoder.encode(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const tick = async () => {
          if (closed) return;
          try {
            const song = await getSong(songId, user.id);
            if (!song) {
              send("error", { code: "NOT_FOUND", message: "song not found" });
              controller.close(); closed = true; return;
            }
            send("status", {
              status: song.status,
              measureCount: song.measureCount,
              scoreMeasureCount: song.scoreMeasureCount,
              keySignature: song.keySignature,
              timeSignature: song.timeSignature,
              detectedTempo: song.detectedTempo,
              warnings: song.warnings,
              failureMessage: scoreProgressFailureMessage(song),
            });
            if (isScoreProgressTerminal(song.status) || Date.now() - startedAt > MAX_DURATION_MS) {
              send("done", { status: song.status });
              controller.close(); closed = true; return;
            }
            setTimeout(tick, POLL_INTERVAL_MS);
          } catch {
            send("error", { code: "INTERNAL", message: "unable to read score progress" });
            controller.close(); closed = true;
          }
        };
        await tick();
      },
    });
    const id = requestId(request);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive", "X-Request-Id": id, "X-Api-Version": "1",
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
```

- [ ] **Step 2: 共有フックを実装する**

`src/lib/hooks/useSongScoreProgress.ts`

```ts
"use client";

import { useEffect, useState } from "react";
import type { SongDocStatus } from "@/lib/server/types";

export interface ScoreInfo {
  measureCount: number;
  timeSignature: string;
  keySignature: string;
  detectedTempo: number;
  warnings: { code: string; message: string }[];
}

export interface SongScoreProgress {
  status: SongDocStatus | null;
  info: ScoreInfo | null;
  failureMessage: string | null;
}

interface StatusEvent {
  status: SongDocStatus;
  measureCount: number | null;
  keySignature: string | null;
  timeSignature: string | null;
  detectedTempo: number | null;
  warnings: { code: string; message: string }[] | null;
  failureMessage: string | null;
}

/**
 * 楽譜登録の進捗を購読する。songId が null の間は何もしない。
 * 参照譜の生成はワーカーが行うため、登録画面と楽譜差し替えの両方がこれで待つ
 * （待ち処理を2箇所に書かないための共有点）。
 */
export function useSongScoreProgress(songId: string | null): SongScoreProgress {
  const [progress, setProgress] = useState<SongScoreProgress>({
    status: null, info: null, failureMessage: null,
  });

  useEffect(() => {
    if (!songId) {
      setProgress({ status: null, info: null, failureMessage: null });
      return;
    }
    const source = new EventSource(`/api/songs/${songId}/events`);
    source.addEventListener("status", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as StatusEvent;
      setProgress({
        status: data.status,
        info: data.status === "ready"
          ? {
              measureCount: data.measureCount ?? 0,
              timeSignature: data.timeSignature ?? "未検出",
              keySignature: data.keySignature ?? "未検出",
              detectedTempo: data.detectedTempo ?? 0,
              warnings: data.warnings ?? [],
            }
          : null,
        failureMessage: data.failureMessage,
      });
    });
    source.addEventListener("done", () => source.close());
    // ブラウザは接続が切れると自動再接続する。上のサーバー側は done で閉じるので、
    // ここで明示的に閉じないと終端後に再接続を繰り返す。
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [songId]);

  return progress;
}
```

- [ ] **Step 3: 登録画面をフックで待たせる**

`src/app/songs/new/page.tsx` の `Phase` から `awaiting_score` を外し、`parsing` を待機フェーズとして使う。

```ts
type Phase = "idle" | "uploading" | "converting" | "reviewing" | "parsing" | "done" | "error";
```

`handleFile` の `:74-87`（`setStep(STEPS.length)` 以降の分岐）を次に置き換える。

```ts
      setStep(STEPS.length);
      // 参照譜の生成はワーカーが行う。ここでは parsing のまま SSE の結果を待つ。
      setWatchedSongId(created.songId);
```

コンポーネント本体にフックと反映処理を足す。

```ts
  const [watchedSongId, setWatchedSongId] = useState<string | null>(null);
  const progress = useSongScoreProgress(watchedSongId);

  useEffect(() => {
    if (!progress.status) return;
    if (progress.status === "ready" && progress.info) {
      setScoreInfo(progress.info);
      setPhase("done");
      return;
    }
    if (progress.failureMessage) {
      setErrorMessage(progress.failureMessage);
      setPhase("error");
    }
  }, [progress]);
```

`:213-217` の `phase === "awaiting_score"` のブロックを、`parsing` のときに出る待機メッセージへ置き換える。

```tsx
                  {phase === "parsing" && (
                    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-xs text-amber-200">
                      楽譜を受け付けました。解析ワーカーが小節・拍子・調を抽出しています。この画面のまま少しお待ちください。
                    </div>
                  )}
```

`useEffect` と `useSongScoreProgress` の import を追加する。

- [ ] **Step 4: 楽譜差し替えもフックで待たせる**

`src/components/VerifiedScoreReplacement.tsx` の `replaceScore` を次にする。

```tsx
  async function replaceScore(file: File) {
    setStatus("解析中…");
    setError("");
    try {
      const result = await uploadScore(songId, file);
      if (result.status !== "parsing_score") {
        throw new Error("楽譜のアップロードを受け付けられませんでした。");
      }
      setWatching(true);
    } catch (cause) {
      setStatus("");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }
```

`watching` を state に持ち、フックの結果を反映する。

```tsx
  const [watching, setWatching] = useState(false);
  const progress = useSongScoreProgress(watching ? songId : null);

  useEffect(() => {
    if (!progress.status) return;
    if (progress.status === "ready") {
      setWatching(false);
      setStatus("差し替えが完了しました。");
      router.refresh();
      return;
    }
    if (progress.failureMessage) {
      setWatching(false);
      setStatus("");
      setError(progress.failureMessage);
    }
  }, [progress, router]);
```

- [ ] **Step 5: 型・lint・ビルドを確認する**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: いずれもエラーなし

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/app/api/songs src/lib/hooks src/app/songs/new/page.tsx src/components/VerifiedScoreReplacement.tsx
git commit -m "feat: stream score registration progress and wait for it in the UI"
```

---

## Task 8: スモークの実データ化、E2E 検証、ドキュメント更新

**Files:**
- Modify: `scripts/azure-local-smoke.ts:90-99`（楽譜アップロード）、`:100` の直前（`ready` 待ち）
- Modify: `docs/spec/api.md:314-339`（5.1 の契約）
- Modify: `worker/README.md:80-95`（既知の限界）、`:105-136`（本番ワーカー）、`:151-168`（実装済みエンドポイント表）

**Interfaces:**
- Consumes: Task 3〜7 のすべて
- Produces: なし（検証とドキュメント）

- [ ] **Step 1: スモークが実在の楽譜で `ready` を待つようにする**

`scripts/azure-local-smoke.ts` の HTTP スモーク（`:90-99`）を次にする。

```ts
  if (songResponse.upload?.url) {
    // 最小の空 MusicXML では music21 が小節を1つも読めない。参照譜の生成まで
    // 通すこと自体がこのスモークの目的（Issue #33 の再発検出）なので、
    // アプリが配信している実在のサンプル譜をそのまま使う。
    const score = await fs.readFile(path.join(process.cwd(), "public/scores/etude-in-a-minor.musicxml"));
    const upload = await fetch(songResponse.upload.url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/vnd.recordare.musicxml+xml" },
      body: score,
    });
    assert.ok(upload.ok, `score upload failed: ${upload.status}`);
    await json(`/api/songs/${songId}/score/complete`, { method: "POST" });
  }
  // 参照譜の生成はワーカーが行うため、テイクを作る前に ready を待つ
  // (POST /songs/{songId}/takes は status === "ready" を要求する)。
  let songStatus: string | undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    const song = (await json(`/api/songs/${songId}`)).song;
    songStatus = song.status;
    if (songStatus === "ready") break;
    if (songStatus === "awaiting_score") {
      throw new Error(`reference generation failed: ${song.lastScoreError ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(songStatus, "ready");
```

`fs`（`node:fs/promises`）と `path` は既に import 済み（`:2-3`）なので追加は不要。`public/scores/etude-in-a-minor.musicxml` は登録画面の「サンプル譜を使う」ボタンが fetch しているファイルで、リポジトリに存在する。

決定論的スモーク（`deterministicSmoke`、`:30-74`）は**変更不要**。`repository.createTake` を直接呼んでおり、`status === "ready"` を要求する API ルート（`src/app/api/songs/[songId]/takes/route.ts:44-46`）を通らないため、今回の変更の影響を受けない。

- [ ] **Step 2: スモークを走らせる**

```bash
npm run azure:up
npm run azure:start      # 別ターミナルで Next.js が起動する
npm run test:azure-local  # scripts/azure-local-smoke.ts
```

Expected: `HTTP local Azure smoke passed: song -> score -> take -> upload -> queue -> status -> coach.`

ワーカーのログで参照譜ジョブが処理されていることを確認する。

```bash
docker compose -f docker-compose.azure-local.yml logs worker | Select-String "Score job"
```

Expected: `Score job job_... outcome=completed song=song_...`

- [ ] **Step 3: #33 の完了条件を手で確認する**

**`worker/README.md` の回避策（`python worker_main.py --mode reference` の手動実行）を使わずに**、次を通す。

1. `npm run azure:up` / `npm run azure:start`
2. ブラウザで曲を追加 → `.data/summer-jiu-shi-rang.mxl`（または任意の MusicXML / MXL / MIDI）をアップロード
3. 登録画面が待機表示になり、**そのまま `ready` に切り替わって「N小節 / 拍子 / 調 を認識しました」が出る**
4. その曲で録音し、解析が `completed` まで完走する
5. 壊れたファイル（拡張子だけ `.musicxml` にしたテキスト）をアップロードすると、待機後に `lastScoreError` の内容がエラー表示される
6. ブラウザのコンソールに新規の warning / error が出ていない

Expected: 3 と 4 が通ること。これが #33 の完了条件である。

- [ ] **Step 4: ドキュメントを更新する**

`docs/spec/api.md` の `POST /songs/{songId}/score`（`:314-339`）を非同期契約に書き換える。

- 「サーバーは MusicXML を解析し、繰り返しを展開して `reference.json` を生成する（同期処理、通常 1-3秒）」→ 「サーバーは楽譜を保存して曲を `parsing_score` にし、参照譜の生成をワーカーへ投入する。**202 を返す。**小節数・拍子・調は生成完了後に `GET /songs/{songId}` または `GET /songs/{songId}/events`（SSE）で取得する」
- 200 のレスポンス例を 202 の例（`{ "songId": "...", "status": "parsing_score", "uploadComplete": true }`）に差し替える
- 「パースに失敗した場合は `400 VALIDATION_FAILED` を返し、曲は `awaiting_score` のまま残る」→ 「パースの失敗は 202 の後に判明する。曲は `awaiting_score` に戻り、`lastScoreError` に理由が入る」
- `GET /songs/{songId}/events` の項を追加する（イベント名 `status` / `done` / `error` と、終端になる status を明記）
- 曲の status 一覧に `parsing_score` を追加する

`worker/README.md`:

- 「既知の限界」の**回避策の節を削除**し、「参照譜の生成は `score-jobs` キュー経由でワーカーが行う」に書き換える
- 「Azure 本番ワーカー」の節に、ワーカーが `score-jobs` と `analysis-jobs` の2本を消費すること、参照譜を優先すること、単一レプリカなので実行中の解析は追い越せないことを追記する
- 実装済みエンドポイント表の `POST /api/songs/{songId}/score` の差分欄を「保存後にキューへ投入し 202 を返す（参照譜はワーカーが生成）」に更新する

- [ ] **Step 5: 全体を再確認する**

Run: `npm run test:unit && npm run test:production && npx tsc --noEmit && npm run lint && npm run build`
Expected: すべてエラーなし

Run: `cd worker && python tests/test_score_job.py && python tests/test_worker_main.py && python tests/test_confidence.py`
Expected: すべて `OK`

- [ ] **Step 6: コミット**

```bash
git add scripts/azure-local-smoke.ts docs/spec/api.md worker/README.md
git commit -m "test: cover score registration end to end and document the async contract"
```

---

## 完了の定義

1. エミュレータプロファイルで、回避策なしに MusicXML / MXL / MIDI を登録して `ready` になり、その曲で録音の解析が完走する（Task 8 Step 3）
2. 参照譜を生成する経路が Queue の1本だけになっている（`git grep processCloudScoreLocally` が空）
3. `ready` を名乗る曲が必ず `reference.json` を持っている（`score/complete` の捏造が削除されている）
4. 壊れた楽譜が `awaiting_score` + `lastScoreError` で終端し、`parsing_score` のまま残らない
5. `npm run test:unit` / `test:production` / `tsc --noEmit` / `lint` / `build`、ワーカーの unittest がすべて通る

## この計画に含まれないもの

- PDF / OMR の Queue 化（別 issue として起票する）
- 真の push（Web PubSub / Cosmos change feed）
- 繰り返し展開（#37）
- 総合スコアが `null` である問題（#40）
- 専用 Container App への分離（設計 §3.2。単一レプリカの待ち時間が問題になったとき）
