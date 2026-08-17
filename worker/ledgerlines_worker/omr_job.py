"""PDF の OMR ジョブの純ロジック（Azure SDK に依存しない）。

`cloud_worker.py` がキューの受信とストア実装（Blob / Cosmos）を担い、この
モジュールは「曲ドキュメントをどう遷移させ、どの成果物を上げ、メッセージを
削除してよいか」だけを決める。`score_job.py` と同じ方針で azure.* を import
しないので、ワーカーイメージ以外でも単体テストが動く。

OMR 自体は `worker_main.run_omr` が行う。ここでは呼ぶだけで再実装しない
（設計 §4.3）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Protocol

# 曲が永久に converting_score のまま残るのを防ぐための試行上限。
# score_job.MAX_ATTEMPTS と同じ理由・同じ値。
MAX_ATTEMPTS = 3

# run_omr が確定させる曲ドキュメントのフィールド。
RESULT_FIELDS = (
    "scoreFileName",
    "sourceScoreFileName",
    "scoreSource",
    "omrEngine",
    "omrError",
    "lastScoreError",
    "previewScoreFileName",
    "previewMidiFileName",
    "warnings",
)


class OmrStore(Protocol):
    def get_song(self, song_id: str, user_id: str) -> dict[str, Any] | None: ...

    def update_song(self, song_id: str, user_id: str, patch: dict[str, Any]) -> Any: ...

    def download_score(self, song: dict[str, Any], target_dir: Path) -> Path: ...

    def upload_preview(self, song: dict[str, Any], file_name: str, source: Path) -> None: ...


def process_omr_job(
    store: OmrStore,
    job: dict[str, Any],
    dequeue_count: int,
    work_dir: Path,
    run_omr: Callable[[Path, str], int],
) -> str:
    """PDF を MusicXML 化し、曲を reviewing_score / omr_failed へ遷移させる。

    戻り値は呼び出し側がメッセージを削除してよいかの判断に使う。
    "completed" / "failed" / "skipped" / "exhausted" はいずれも削除してよい。
    再配信させたい失敗は例外として送出する（メッセージを残す）。
    """
    try:
        return _run_omr_job(store, job, work_dir, run_omr)
    except Exception as exc:  # noqa: BLE001
        if dequeue_count < MAX_ATTEMPTS:
            raise
        song_id = job.get("songId")
        user_id = job.get("userId")
        if not song_id or not user_id:
            # 宛先が特定できないので omrError を残せない。メッセージを残しても
            # 同じ失敗を繰り返すだけなので削除させる。利用者は曲詳細からの
            # 差し替えで先へ進める。
            return "skipped"
        # update_song 自身が投げた場合は送出させる（メッセージを残す）。終端状態を
        # 書けないまま消すと、曲が converting_score のまま孤立する。
        store.update_song(
            song_id,
            user_id,
            {"status": "omr_failed", "omrError": str(exc)},
        )
        return "exhausted"


def _run_omr_job(
    store: OmrStore,
    job: dict[str, Any],
    work_dir: Path,
    run_omr: Callable[[Path, str], int],
) -> str:
    """試行上限を意識しない本体。失敗は素通しして呼び出し側に判断させる。"""
    song_id = job["songId"]
    user_id = job["userId"]
    song = store.get_song(song_id, user_id)
    if song is None:
        return "skipped"
    if song.get("status") != "converting_score":
        # 再配信の重複か、利用者が楽譜を差し替えて別のジョブが処理済み。
        # 完了済みの曲を OMR ドラフトで上書きするのは害にしかならない。
        return "skipped"

    score_dir = _materialize_inputs(store, song, work_dir)
    code = run_omr(work_dir, song_id)
    parsed = json.loads(
        (work_dir / "songs" / f"{song_id}.json").read_text(encoding="utf-8")
    )

    if code != 0 or parsed.get("status") != "reviewing_score":
        store.update_song(
            song_id,
            user_id,
            {
                "status": "omr_failed",
                "omrError": parsed.get("omrError") or "OMR conversion failed",
            },
        )
        return "failed"

    # 変換後の楽譜とプレビューのファイル名は run_omr が決める（入力の拡張子と
    # Audiveris の出力で変わる）。決め打ちしてはいけない。同じ名前が複数の
    # フィールドに現れ得るので重複を除く。
    for file_name in dict.fromkeys(
        name
        for name in (
            parsed.get("scoreFileName"),
            parsed.get("previewScoreFileName"),
            parsed.get("previewMidiFileName"),
        )
        if name
    ):
        store.upload_preview(song, file_name, score_dir / file_name)

    store.update_song(
        song_id,
        user_id,
        {
            "status": "reviewing_score",
            **{key: parsed.get(key) for key in RESULT_FIELDS if key in parsed},
        },
    )
    return "completed"


def _materialize_inputs(store: OmrStore, song: dict[str, Any], work_dir: Path) -> Path:
    """run_omr が期待するファイルレイアウトを一時領域に用意する。

    戻り値は成果物が置かれるディレクトリ（run_omr は変換後の楽譜を PDF と同じ
    ディレクトリに書く）。
    """
    songs_dir = work_dir / "songs"
    songs_dir.mkdir(parents=True, exist_ok=True)
    (songs_dir / f"{song['id']}.json").write_text(
        json.dumps(song, ensure_ascii=False), encoding="utf-8"
    )
    score_dir = work_dir / "scores" / song["id"]
    score_dir.mkdir(parents=True, exist_ok=True)
    store.download_score(song, score_dir)
    return score_dir
