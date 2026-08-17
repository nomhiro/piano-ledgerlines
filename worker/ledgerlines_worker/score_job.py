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

# 曲が永久に parsing_score のまま残るのを防ぐための試行上限。処理中に出た
# 例外すべてに適用する（Blob / Cosmos の一時的な失敗は再試行に意味があり、
# 恒久的な失敗やプログラミングエラーはここで打ち切られる）。
# 楽譜そのものが壊れている場合は run_reference が終了コード1で戻るため、
# 例外にはならず1回目で awaiting_score に落として終端する（下の "failed" 分岐）。
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

    試行上限の判定は処理全体をくるむここで行う。設計 §4.3 は
    「dequeue_count >= 3 で awaiting_score + lastScoreError を書いて削除する」を
    無条件に規定しており、これを一部の区間（ダウンロード＋パース）に限ると、
    アップロード / Cosmos 更新の恒久失敗と不正なジョブメッセージが上限に達しても
    終端せず、曲が永久に parsing_score のまま再配信され続ける。
    """
    try:
        return _run_score_job(store, job, work_dir, run_reference)
    except Exception as exc:  # noqa: BLE001
        # 一時失敗（Blob / Cosmos）もプログラミングエラー（KeyError,
        # JSONDecodeError 等）も同じ上限で終端させる。後者は再試行しても
        # 決定論的に失敗するが、上限があるので無限には回らない。
        if dequeue_count < MAX_ATTEMPTS:
            raise
        song_id = job.get("songId")
        user_id = job.get("userId")
        if not song_id or not user_id:
            # ジョブメッセージが壊れていて曲を特定できない。update_song の宛先が
            # 無いので lastScoreError は残せないが、メッセージを残しても永久に
            # 同じ KeyError を繰り返すだけなので "skipped"（呼び出し側が削除して
            # よい戻り値）を返す。曲側は enqueue 元が特定できない以上ここでは
            # 触れられず、ユーザーは曲詳細からの差し替えで新しいジョブを積める。
            return "skipped"
        # ここで update_song 自身が投げた場合は送出させる（メッセージを残す）。
        # 終端状態を書けないままメッセージを消すと、曲が parsing_score のまま
        # 誰も再開できない状態で孤立する。残せば Cosmos 回復後に終端できる。
        store.update_song(
            song_id,
            user_id,
            {"status": "awaiting_score", "lastScoreError": str(exc)},
        )
        return "exhausted"


def _run_score_job(
    store: ScoreStore,
    job: dict[str, Any],
    work_dir: Path,
    run_reference: Callable[[Path, str], int],
) -> str:
    """試行上限を意識しない本体。失敗は素通しして呼び出し側に判断させる。"""
    song_id = job["songId"]
    user_id = job["userId"]
    song = store.get_song(song_id, user_id)
    if song is None:
        return "skipped"
    if song.get("status") != "parsing_score":
        # 再配信の重複か、ユーザーが楽譜を差し替えて別のジョブが処理済み。
        # 完了済みの曲を作り直して warnings を書き戻すのは害にしかならない。
        return "skipped"

    score_path = _materialize_inputs(store, song, work_dir)
    code = run_reference(work_dir, song_id)
    parsed = json.loads(
        (work_dir / "songs" / f"{song_id}.json").read_text(encoding="utf-8")
    )

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
