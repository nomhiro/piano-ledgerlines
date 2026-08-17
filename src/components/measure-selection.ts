// 楽譜ビューで選んだ小節から、指摘事項を絞り込むための対応付け（#36）。
//
// 番号が2系統あることがこの絞り込みの本質的な難所（`docs/spec/api.md:72`）:
//
//   measure       繰り返し展開後の演奏順小節番号。`issues[].measures` と
//                 小節スコアの数字グリッドはこちらを使う
//   scoreMeasure  楽譜上の小節番号。OSMD が描くのは楽譜そのものなので、
//                 `ScoreView` のクリックが返すのはこちら
//
// 繰り返しを展開すると複数の演奏順小節が同じ楽譜上の小節に写るため、
// 突き合わせは「楽譜上の小節 → 演奏順小節の集合」を経由する必要がある。
// 現在は繰り返し展開が無効（`worker_main.py` の `hasRepeats: False`）で両者が
// 一致するため結果は同じだが、有効にした日に静かに壊れないようにしてある。

export interface MeasureNumbering {
  measure: number;
  /** 楽譜上の小節番号。持たない古いデータは演奏順にフォールバックする。 */
  scoreMeasure?: number;
}

/** その小節が楽譜上で何小節目に印刷されるか。 */
export function printedMeasureOf(measure: MeasureNumbering): number {
  return measure.scoreMeasure ?? measure.measure;
}

/**
 * 楽譜上の小節 `printed` に写る演奏順小節をすべて返す。
 * `printed` が `null`（未選択）なら空を返す——絞り込むかどうかの判断は
 * `issuesForSelection` が持つ。
 */
export function performanceMeasuresFor(
  measureScores: readonly MeasureNumbering[],
  printed: number | null,
): number[] {
  if (printed === null) return [];
  return measureScores
    .filter((measure) => printedMeasureOf(measure) === printed)
    .map((measure) => measure.measure);
}

/**
 * 選択された楽譜上の小節に関わる指摘事項だけを返す。元の並び順は保つ。
 *
 * **未選択（`null`）と「該当0件」は別物。** 未選択なら全件返す——ここを混同すると、
 * 何も選んでいない画面の指摘事項が空に見える。
 */
export function issuesForSelection<T extends { measures: number[] }>(
  issues: readonly T[],
  measureScores: readonly MeasureNumbering[],
  printed: number | null,
): T[] {
  if (printed === null) return [...issues];
  const target = new Set(performanceMeasuresFor(measureScores, printed));
  return issues.filter((issue) => issue.measures.some((measure) => target.has(measure)));
}
