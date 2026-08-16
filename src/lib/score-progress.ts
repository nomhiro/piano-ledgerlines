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
