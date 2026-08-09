"""Azure Storage Queue consumer for the production analysis pipeline."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from azure.cosmos import CosmosClient
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.storage.queue import QueueClient

from ledgerlines_worker.reference import build_reference
from worker_main import run_analyze

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


class CloudStore:
    def __init__(self) -> None:
        credential = DefaultAzureCredential()
        self.account_url = required("AZURE_STORAGE_ACCOUNT_URL").rstrip("/")
        self.queue_url = os.environ.get("AZURE_STORAGE_QUEUE_URL", self.account_url.replace(".blob.", ".queue.")).rstrip("/")
        self.storage = BlobServiceClient(self.account_url, credential)
        self.queue = QueueClient(
            account_url=self.queue_url,
            queue_name=required("AZURE_ANALYSIS_QUEUE"),
            credential=credential,
        )
        cosmos = CosmosClient(required("AZURE_COSMOS_ENDPOINT"), credential)
        database = cosmos.get_database_client(os.environ.get("AZURE_COSMOS_DATABASE", "ledgerlines"))
        self.takes = database.get_container_client(os.environ.get("AZURE_COSMOS_TAKES_CONTAINER", "takes"))
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


def sync_local_doc(store: CloudStore, job: dict[str, Any], document: dict[str, Any]) -> None:
    patch = {
        key: document[key]
        for key in (
            "status",
            "progress",
            "failure",
            "overallScore",
            "metrics",
            "metricsNAReason",
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
        reference_path = store.download_json(
            f"users/{user_id}/songs/{song_id}/reference.json",
            data_dir / "derived" / song_id / "reference.json",
        )
        stored_reference = json.loads(reference_path.read_text(encoding="utf-8"))
        score_path = store.download_first(
            store.scores,
            f"users/{user_id}/songs/{song_id}/scores/score.",
            data_dir / "scores" / song_id,
        )
        reference = build_reference(
            score_path,
            tempo_bpm=float(stored_reference.get("estimatedTempo", 96.0)),
        )
        reference_path.write_text(json.dumps(reference, ensure_ascii=False), encoding="utf-8")
        store.upload(
            store.derived,
            f"users/{user_id}/songs/{song_id}/reference.json",
            reference_path,
            "application/json",
        )

        update: Callable[[dict[str, Any]], None] = lambda document: sync_local_doc(store, job, document)
        result_code = run_analyze(data_dir, take_id, on_update=update)
        final_document = json.loads((data_dir / "takes" / f"{take_id}.json").read_text(encoding="utf-8"))

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


def main() -> None:
    store = CloudStore()
    polling_seconds = int(os.environ.get("WORKER_POLLING_SECONDS", "5"))
    visibility_seconds = int(os.environ.get("WORKER_VISIBILITY_TIMEOUT_SECONDS", "1800"))
    LOGGER.info("Analysis worker started")
    while True:
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
