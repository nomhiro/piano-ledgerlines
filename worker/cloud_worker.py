"""Azure Storage Queue consumer for the production analysis pipeline."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from azure.cosmos import CosmosClient
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.storage.queue import QueueClient

from ledgerlines_worker.score_job import MAX_ATTEMPTS, process_score_job
from worker_main import run_analyze, run_reference

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
LOGGER = logging.getLogger("ledgerlines.worker")


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


# 参照譜ジョブのキュー名は required() ではなく既定値で解決する。
# CD (.github/workflows/azure-container-apps-cd.yml) は `az containerapp update
# --image` だけを行い Bicep を流さないため、AZURE_SCORE_QUEUE を持たない
# Container App に新しいイメージが先に入り得る。そこで required() を使うと
# ワーカーが起動時に落ちて再起動ループになり、解析パイプライン全体が止まる。
# TS側 (src/lib/server/config.ts の `scoreQueueName`) も同じ既定値を持つ。
DEFAULT_SCORE_QUEUE = "score-jobs"


def score_queue_name() -> str:
    # `os.environ.get(name, DEFAULT)` では env が空文字で設定されている場合に ""
    # を返してキュー名が空になる。required() が空文字を欠落として扱うのと
    # 同じ意味論を保つため、strip() してから or で既定値へ落とす。
    return os.environ.get("AZURE_SCORE_QUEUE", "").strip() or DEFAULT_SCORE_QUEUE


# LEDGERLINES_AZURE_EMULATOR=true が選ぶ分岐は接続文字列・固定キーで認証し、かつ
# Cosmosの証明書検証を無効化する（下のconnection_verify=False）。これはローカルの
# Azurite/Cosmosエミュレータ向けの既知の対処であり、本物のAzureエンドポイントに
# 対して行うと資格情報の質・TLS保護の両方を落とす。
# TS側 (config.ts) はNODE_ENV==="production"を見て起動時に弾くが、このワーカーに
# 相当する実行時シグナルは無く、無理に模倣すると仕組みだけを真似た形になる。
# 危険の実体はもっと狭い ── 「エミュレータ用の認証・TLS無効化を、実在のAzure
# エンドポイントに向けて送ってしまうこと」なので、それを直接防ぐために接続先の
# ホスト名そのものを検査する。infra/modules/analysis-worker.bicep が
# LEDGERLINES_AZURE_EMULATOR を設定しない、という前提には依存しない
# （IaCの記述ミスや将来の変更に関わらず、ここでホスト名を見て弾く）。
_LOCAL_EMULATOR_HOSTS = frozenset({
    "localhost", "127.0.0.1",  # .env.local.azure.example（ホストで動くNext.js向け）
    "azurite", "cosmos",       # docker-compose.azure-local.yml のサービス名（ワーカー用）
})


def _assert_emulator_endpoints_are_local(cosmos_endpoint: str, storage_connection_string: str) -> None:
    hosts: set[str | None] = {urlparse(cosmos_endpoint).hostname}
    for endpoint_key in ("BlobEndpoint", "QueueEndpoint"):
        match = re.search(rf"{endpoint_key}=([^;]+)", storage_connection_string)
        if match:
            hosts.add(urlparse(match.group(1)).hostname)
    unrecognized = sorted(h for h in hosts if h and h.lower() not in _LOCAL_EMULATOR_HOSTS)
    if unrecognized:
        raise RuntimeError(
            "LEDGERLINES_AZURE_EMULATOR=true ですが、ローカルエミュレータ以外の"
            f"ホストが設定に含まれています: {unrecognized}。この設定はTLS証明書検証を"
            "無効化するため、本物のAzureエンドポイントに向けて使うのは危険です。"
            f"AZURE_COSMOS_ENDPOINT / AZURE_STORAGE_CONNECTION_STRING を確認してください"
            f"（許可ホスト: {sorted(_LOCAL_EMULATOR_HOSTS)}）。"
        )


class CloudStore:
    def __init__(self) -> None:
        # TypeScript側 (src/lib/server/config.ts の `azureEmulator`) と同じフラグ・
        # 同じ判定式を使う。本番パス（下のelse節）はこのフラグが立っていない限り、
        # DefaultAzureCredentialと通常のTLS検証のまま従来どおり動く。
        emulator = os.environ.get("LEDGERLINES_AZURE_EMULATOR", "").strip() == "true"
        if emulator:
            # Azurite/Cosmosエミュレータは接続文字列・固定キーで認証する
            # （DefaultAzureCredentialは使えない）。TS側の対応箇所:
            # blob-storage.ts:104-106 (BlobServiceClient.fromConnectionString)、
            # queue.ts:36-37 (QueueServiceClient.fromConnectionString)。
            connection_string = required("AZURE_STORAGE_CONNECTION_STRING")
            cosmos_endpoint = required("AZURE_COSMOS_ENDPOINT")
            _assert_emulator_endpoints_are_local(cosmos_endpoint, connection_string)
            self.storage = BlobServiceClient.from_connection_string(connection_string)
            self.queue = QueueClient.from_connection_string(
                connection_string,
                required("AZURE_ANALYSIS_QUEUE"),
            )
            self.score_queue = QueueClient.from_connection_string(
                connection_string,
                score_queue_name(),
            )
            cosmos = CosmosClient(
                cosmos_endpoint,
                credential=required("AZURE_COSMOS_KEY"),
                # Cosmosエミュレータはlocalhost向けの自己署名証明書で応答する。
                # コンテナネットワーク越しに別ホスト名（例: `cosmos`）で接続すると
                # ホスト名検証に失敗するため、エミュレータ限定でTLS検証を無効化する。
                # TS側の対応箇所: cosmos-repository.ts:65-77
                # （`rejectUnauthorized: false` の https.Agent）と同じ理由・同じ範囲。
                connection_verify=False,
            )
        else:
            credential = DefaultAzureCredential()
            self.account_url = required("AZURE_STORAGE_ACCOUNT_URL").rstrip("/")
            self.queue_url = os.environ.get("AZURE_STORAGE_QUEUE_URL", self.account_url.replace(".blob.", ".queue.")).rstrip("/")
            self.storage = BlobServiceClient(self.account_url, credential)
            self.queue = QueueClient(
                account_url=self.queue_url,
                queue_name=required("AZURE_ANALYSIS_QUEUE"),
                credential=credential,
            )
            self.score_queue = QueueClient(
                account_url=self.queue_url,
                queue_name=score_queue_name(),
                credential=credential,
            )
            cosmos = CosmosClient(required("AZURE_COSMOS_ENDPOINT"), credential)
        database = cosmos.get_database_client(os.environ.get("AZURE_COSMOS_DATABASE", "ledgerlines"))
        self.takes = database.get_container_client(os.environ.get("AZURE_COSMOS_TAKES_CONTAINER", "takes"))
        self.songs = database.get_container_client(os.environ.get("AZURE_COSMOS_SONGS_CONTAINER", "songs"))
        self.audio = self.storage.get_container_client(os.environ.get("AZURE_STORAGE_AUDIO_CONTAINER", "audio"))
        self.scores = self.storage.get_container_client(os.environ.get("AZURE_STORAGE_SCORES_CONTAINER", "scores"))
        self.derived = self.storage.get_container_client(os.environ.get("AZURE_STORAGE_DERIVED_CONTAINER", "derived"))

    def get_take(self, take_id: str, user_id: str) -> dict[str, Any] | None:
        try:
            return self.takes.read_item(item=take_id, partition_key=user_id)
        except ResourceNotFoundError:
            return None

    def update_take(self, take_id: str, user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self.get_take(take_id, user_id)
        if current is None:
            raise RuntimeError(f"take {take_id} not found")
        current.update(patch)
        current["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return self.takes.replace_item(item=take_id, body=current)

    def download_first(self, container, prefix: str, target: Path) -> Path:
        blob = next(container.list_blobs(name_starts_with=prefix), None)
        if blob is None:
            raise FileNotFoundError(f"blob not found: {prefix}")
        target = target / Path(blob.name).name
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(container.download_blob(blob.name).readall())
        return target

    def download_json(self, prefix: str, target: Path) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.derived.download_blob(prefix).readall())
        return target

    def upload(self, container, name: str, source: Path, content_type: str) -> None:
        with source.open("rb") as handle:
            container.upload_blob(
                name,
                handle,
                overwrite=True,
                content_settings=ContentSettings(content_type=content_type),
            )

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


def sync_local_doc(store: CloudStore, job: dict[str, Any], document: dict[str, Any]) -> None:
    patch = {
        key: document[key]
        for key in (
            "status",
            "progress",
            "failure",
            "overallScore",
            "metrics",
            "metricConfidence",
            "metricEvaluations",
            "metricsNAReason",
            "evaluation",
            "measureScores",
            "issues",
            "aiReview",
            "analysis",
        )
        if key in document
    }
    store.update_take(job["takeId"], job["userId"], patch)


def process_job(store: CloudStore, job: dict[str, Any]) -> None:
    take_id = job["takeId"]
    user_id = job["userId"]
    song_id = job["songId"]
    take = store.get_take(take_id, user_id)
    if take is None:
        LOGGER.warning("Skipping missing take %s", take_id)
        return
    if take.get("status") == "completed":
        LOGGER.info("Skipping completed take %s", take_id)
        return

    with tempfile.TemporaryDirectory(prefix=f"ledgerlines-{take_id}-") as temp:
        root = Path(temp)
        data_dir = root / "data"
        (data_dir / "takes").mkdir(parents=True)
        (data_dir / "audio" / take_id).mkdir(parents=True)
        (data_dir / "derived" / song_id).mkdir(parents=True)
        (data_dir / "songs").mkdir(parents=True)
        (data_dir / "takes" / f"{take_id}.json").write_text(json.dumps(take), encoding="utf-8")

        audio_prefix = f"users/{user_id}/songs/{song_id}/takes/{take_id}/original"
        store.download_first(store.audio, audio_prefix, data_dir / "audio" / take_id)
        store.download_json(
            f"users/{user_id}/songs/{song_id}/reference.json",
            data_dir / "derived" / song_id / "reference.json",
        )

        update: Callable[[dict[str, Any]], None] = lambda document: sync_local_doc(store, job, document)
        result_code = run_analyze(data_dir, take_id, on_update=update)
        final_document = json.loads((data_dir / "takes" / f"{take_id}.json").read_text(encoding="utf-8"))
        evaluation = final_document.get("evaluation") or {}
        LOGGER.info(
            "Evaluation outcome take=%s status=%s reason=%s calibration=%s",
            take_id,
            evaluation.get("status"),
            evaluation.get("reasonCode"),
            evaluation.get("calibrationVersion"),
        )

        derived_prefix = f"users/{user_id}/songs/{song_id}/takes/{take_id}"
        transcription = data_dir / "derived-takes" / take_id / "transcription.mid"
        alignment = data_dir / "derived-takes" / take_id / "alignment.json"
        if transcription.exists():
            store.upload(store.derived, f"{derived_prefix}/transcription.mid", transcription, "audio/midi")
        if alignment.exists():
            store.upload(store.derived, f"{derived_prefix}/alignment.json", alignment, "application/json")

        if result_code != 0 and final_document.get("status") not in {"failed", "completed"}:
            store.update_take(
                take_id,
                user_id,
                {"status": "failed", "failure": {"code": "INTERNAL", "message": "analysis worker failed"}},
            )


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
            # prefix はデバッグ用のラベルに過ぎないので、songId が欠けていても
            # ここで落とさない。落とすと process_score_job に制御が届かず、
            # 試行上限（id が取れないときに "skipped" を返して削除させる分岐）に
            # 一度も到達できないまま無限に再配信される。
            with tempfile.TemporaryDirectory(prefix=f"ledgerlines-score-{job.get('songId', 'unknown')}-") as temp:
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


if __name__ == "__main__":
    main()
