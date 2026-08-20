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
 * - `reviewing_score` は比較用ドラフトの終端状態。承認して先へ進む経路は無く
 *   （`score/approve` は常に ValidationError を返す）、先へ進むには正しい
 *   MusicXML / MXL / MIDI へ差し替える必要がある
 * - `converting_score`（PDF の OMR 実行中）は非終端。azure バックエンドでは
 *   `omr-jobs` をワーカーが処理し、通常は `omr_failed` / `reviewing_score` へ
 *   遷移して SSE も追従する（#45。実測では失敗経路が約31秒、成功経路が約108秒。
 *   4ページ1件の実測であり全ケースの保証ではない）。ワーカーが処理できない
 *   場合の保険として、終端にはせずストリームの時間上限に任せる
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

const STALLED_MESSAGE = "解析が完了しませんでした。時間をおいて曲の詳細をご確認ください。";

/**
 * SSE の `done` は「進捗が変化しない状態に達した」ことしか意味しない。`ready` でも
 * `scoreProgressFailureMessage` が拾う明示的な失敗（`omr_failed` / `awaiting_score`）
 * でもない状態で `done` になった場合 ── ワーカーが動かず `MAX_DURATION_MS` で
 * 打ち切られた（`parsing_score` / `converting_score` のまま）、あるいは
 * `reviewing_score` のように別フロー待ちのまま終端した場合 ── は、結果が出ないまま
 * 終わったことを待ち手（SSE ルート／`useSongScoreProgress`）に伝える必要がある。
 * 失敗でないときは null を返す。
 */
export function scoreProgressStalledMessage(status: SongDocStatus): string | null {
  if (status === "ready") return null;
  if (scoreProgressFailureMessage({ status }) !== null) return null;
  return STALLED_MESSAGE;
}

const STREAM_INTERRUPTED_MESSAGE = "進捗の取得が中断されました。ページを再読み込みしてください。";

export interface ScoreProgressStreamError {
  code?: string;
  message?: string;
}

/**
 * SSE 接続自体が失敗したときにユーザーへ見せる文言を決める。
 * サーバーが名前付き `error` イベントで理由を送っている場合（SSE ルートの
 * `NOT_FOUND` / `INTERNAL`）はそれに応じた文言を、ブラウザ側の接続断
 * （初回接続失敗や一時的な切断で `error` に data が無い場合）は汎用の文言を返す。
 */
export function scoreProgressStreamErrorMessage(serverError: ScoreProgressStreamError | null): string {
  if (serverError?.code === "NOT_FOUND") {
    return "対象の曲が見つかりませんでした。曲の一覧からやり直してください。";
  }
  if (serverError?.code === "INTERNAL") {
    return "進捗の確認中にエラーが発生しました。ページを再読み込みしてください。";
  }
  return STREAM_INTERRUPTED_MESSAGE;
}
