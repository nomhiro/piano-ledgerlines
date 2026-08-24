// 曲の追加画面で「どの曲に楽譜を送るか」と「その曲を何と名付けるか」の判断（#48）。
//
// 画面から切り離した純粋関数にしてあるのは、失敗後の再投入という経路を
// ブラウザ無しでテストで固定するため。ここが壊れると、楽譜の無い曲が
// ライブラリに溜まるか、曲名が最初の（壊れた）ファイル名のまま残る。

/** 曲の追加画面が受け付ける拡張子。サーバ側の検証と同じ集合。 */
const SCORE_EXTENSION = /\.(musicxml|xml|mxl|mid|midi|pdf)$/i;

/**
 * 新しく曲を作るべきか。
 *
 * 既に `songId` を持っているのは「一度作ったが楽譜の投入で失敗した」状態。
 * そこで作り直すと、楽譜の無い曲がライブラリに溜まる（#48）。同じ曲へ
 * 再投入する。
 */
export function shouldCreateSong(songId: string | null): boolean {
  return songId === null;
}

/**
 * この投入で曲に付ける名前。
 *
 * `titleTouched` はユーザーが曲名の入力欄を触ったか。触っていなければ、
 * 入力欄に入っている値は前回の投入でファイル名から導出したものなので、
 * **今回のファイル名で導出し直す**。これをしないと、失敗した最初のファイル名が
 * 曲名として残り続ける（曲を再利用するようにした副作用）。
 *
 * 触っていても空なら、空の曲名を作らずファイル名に落とす。
 */
export function uploadTitle(opts: {
  titleTouched: boolean;
  title: string;
  fileName: string;
}): string {
  const typed = opts.titleTouched ? opts.title.trim() : "";
  if (typed) return typed;
  // 拡張子だけを落とす。ファイル名の途中のドット（`op.9 no.2`）は残す。
  // 知らない拡張子は落とさない——何を送ったのか分からない曲名になるため。
  const withoutExtension = opts.fileName.replace(SCORE_EXTENSION, "");
  return withoutExtension || opts.fileName;
}
