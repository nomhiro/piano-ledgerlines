import type { SongDoc } from "@/lib/server/types";

/**
 * 楽譜の状態を表示用のラベルにする。
 *
 * 曲詳細（`src/app/songs/[id]/page.tsx`）とダッシュボード（`src/app/page.tsx`）の
 * 両方が出すので共有している。「準備中」と「失敗」をまとめないことが要点——
 * 失敗を準備中と表示すると、ユーザーは終わらない処理を待つことになる。
 */
export function scoreStatusLabel(
  status: SongDoc["status"],
  scoreSource: SongDoc["scoreSource"],
): string {
  if (scoreSource === "pdf") return "OMRドラフト";
  switch (status) {
    case "ready":
      return "解析済み";
    case "parsing_score":
      return "楽譜を解析中";
    case "converting_score":
      return "PDF変換中";
    case "reviewing_score":
      return "変換結果の確認待ち";
    case "omr_failed":
      return "PDF変換失敗";
    default:
      return "楽譜待ち";
  }
}

/** ラベルの色。失敗と確認待ちは目立たせる（放置すると先に進めない状態）。 */
export function scoreStatusColor(
  status: SongDoc["status"],
  scoreSource: SongDoc["scoreSource"],
): string {
  if (status === "omr_failed") return "#f87171";
  if (status === "reviewing_score" || scoreSource === "pdf") return "#fbbf24";
  if (status === "ready") return "#8b5cf6";
  return "#8d97ad";
}
