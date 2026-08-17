// テイク詳細から同じ曲の前後のテイクへ移動するための、隣接テイクの選択（#39）。
// 画面から切り離した純粋関数にしてあるのは、並び順と境界（最古・最新・不在）を
// ネットワークを介さず単体テストで固定するため。

export interface TakeNavItem {
  id: string;
  label: string;
  recordedAt: string;
}

/**
 * `currentId` のテイクから見た、録音日時が1つ古いテイクと1つ新しいテイクを返す。
 *
 * 「前」は古い方、「次」は新しい方。`listTakesBySong` は録音日時の昇順で返すが、
 * その順序に暗黙に依存せずここで並べ直す——並び順が変わった日に前後が静かに
 * 入れ替わるのは、画面を見ても気づけない種類の退行になる。
 *
 * `currentId` が一覧に無い場合（曲情報が未ロード・取得失敗、作成直後で一覧に
 * 載っていない場合）は隣を推測せず両方 null を返す。推測すると無関係なテイクへ
 * 飛ばす導線になる。
 */
export function takeNeighbors(
  takes: readonly TakeNavItem[],
  currentId: string,
): { prev: TakeNavItem | null; next: TakeNavItem | null } {
  const ordered = [...takes].sort(
    // recordedAt が同値のときは id で決めて、入力順に依存しないようにする。
    (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
  );
  const index = ordered.findIndex((take) => take.id === currentId);
  if (index < 0) return { prev: null, next: null };
  return {
    prev: index > 0 ? ordered[index - 1] : null,
    next: index < ordered.length - 1 ? ordered[index + 1] : null,
  };
}
