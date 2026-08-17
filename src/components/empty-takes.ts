// 「まだ見せるものが無い」画面でユーザーを次の行動へ送るための判定。
// /progress と /coach の両方（さらに実データ経路とデモ経路の両方）から使うため、
// DOM にも Next.js にも依存しない純関数として1箇所に置く。
import type { SongDocStatus } from "@/lib/server/types";

export interface EmptyTakesGuidance {
  message: string;
  actionLabel: string;
  actionHref: string;
}

export function guidanceForNoSongs(): EmptyTakesGuidance {
  return {
    message: "まだ曲がありません。",
    actionLabel: "曲を追加する",
    actionHref: "/songs/new",
  };
}

/**
 * 録音が1件も無い曲の空状態。
 *
 * `status` は曲の**登録状態**（`SongDocStatus`）。省略・null はデモ曲を意味する
 * （`src/lib/mock` の `Song.status` は `reading` / `practicing` などの練習状況で
 * 登録状態ではないため、ここへ渡してはいけない）。
 */
export function guidanceForNoTakes(song: {
  id: string;
  status?: SongDocStatus | null;
}): EmptyTakesGuidance {
  // 録音できるのは ready の曲だけ。/record は ready 以外を選択肢に出さず
  // (src/app/record/page.tsx)、テイク作成 API も ready を要求する
  // (src/app/api/songs/[songId]/takes/route.ts)。ready でない曲に録音への導線を
  // 出すと、踏んだ先で進めない。
  if (song.status && song.status !== "ready") {
    return {
      message: "楽譜の準備が終わっていないため、まだ録音できません。",
      actionLabel: "曲の詳細を開く",
      actionHref: `/songs/${song.id}`,
    };
  }
  return {
    message: "この曲にはまだ録音がありません。",
    actionLabel: "録音する",
    actionHref: `/record?song=${song.id}`,
  };
}
