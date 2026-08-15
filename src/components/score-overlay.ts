// ScoreView のヒートマップ計算のうち、DOM と OSMD に依存しない部分。
//
// このモジュールの責務は「判定保留（score: null）を 0 点や最低点として扱わないこと」。
// 旧実装は measureScores を文字列に落として Number() で戻していたため、null が NaN に
// なり、scoreColor(NaN) が最低点の赤を返していた。
//
// 小節番号は2系統ある（docs/spec/api.md:72）。`measure` は繰り返し展開後の演奏順、
// `scoreMeasure` は楽譜上の番号。OSMD が描くのは楽譜そのものなので、重ね合わせは
// scoreMeasure で引く。

export interface MeasureScoreInput {
  /** 繰り返し展開後の演奏順小節番号。 */
  measure: number;
  /** 楽譜上の小節番号。省略時は measure と同じとみなす（モックデータ）。 */
  scoreMeasure?: number;
  /** 採点結果。null は判定保留（0点ではない）。 */
  score: number | null;
}

/**
 * useMemo の依存に使える安定キー。measureScores は毎レンダー新しい配列になり得るため、
 * 内容から作った文字列を依存にする（配列そのものを依存にすると毎回 OSMD を再描画する）。
 * null は数値と衝突しない "null" として書き出す。
 */
export function measureScoreKey(measureScores: readonly MeasureScoreInput[]): string {
  return measureScores
    .map((m) => `${m.scoreMeasure ?? m.measure}:${m.score === null ? "null" : m.score}`)
    .join(",");
}

/** 採点済みが判定保留に勝ち、採点済み同士では低い方（弱い小節）を残す。 */
function mergeScores(existing: number | null, incoming: number | null): number | null {
  if (existing === null) return incoming;
  if (incoming === null) return existing;
  return Math.min(existing, incoming);
}

/**
 * measureScoreKey() の逆変換。「楽譜上の小節番号 → スコア」の対応表を返す。
 * 判定保留は null のまま復元し、キー自体は存在させる（値の無い小節＝このテイクの
 * 対象外と区別するため）。
 */
export function measureScoreMapFromKey(key: string): Map<number, number | null> {
  const map = new Map<number, number | null>();
  if (!key) return map;
  for (const entry of key.split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator < 0) continue;
    const measure = Number(entry.slice(0, separator));
    if (!Number.isFinite(measure)) continue;
    const rawScore = entry.slice(separator + 1);
    const parsed = rawScore === "null" ? null : Number(rawScore);
    // "null" 以外で数値にならない値（"NaN" 等）も保留として扱う。点数に見せない。
    const score = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    map.set(measure, map.has(measure) ? mergeScores(map.get(measure) ?? null, score) : score);
  }
  return map;
}
