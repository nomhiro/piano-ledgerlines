import assert from "node:assert/strict";
import test from "node:test";

import { measureScoreKey, measureScoreMapFromKey, type MeasureScoreInput } from "./score-overlay";

/** ScoreView が useMemo 越しにやっている往復（直列化 → 対応表）をそのまま検証する。 */
function roundTrip(measureScores: MeasureScoreInput[]): Map<number, number | null> {
  return measureScoreMapFromKey(measureScoreKey(measureScores));
}

test("判定保留の小節は null のまま復元される", () => {
  // 旧実装は "2:null" を Number() に通して NaN にしていた。NaN は
  // scoreColor() の全比較を false にして最低点の赤を返すため、
  // 判定保留が「0点相当」として塗られていた（#29 と同じ性質の退行）。
  const map = roundTrip([
    { measure: 1, score: 88 },
    { measure: 2, score: null },
  ]);
  assert.equal(map.get(2), null);
  assert.equal(Number.isNaN(map.get(2) as number), false);
  // 「保留」と「このテイクの対象外」を区別するため、保留の小節もキーは持つ。
  assert.equal(map.has(2), true);
  assert.equal(map.has(3), false);
});

test("小数のスコアが往復しても値が変わらない", () => {
  const map = roundTrip([{ measure: 7, score: 62.5 }]);
  assert.equal(map.get(7), 62.5);
});

test("対応表は楽譜上の小節番号（scoreMeasure）で引ける", () => {
  const map = roundTrip([{ measure: 33, scoreMeasure: 17, score: 71 }]);
  assert.equal(map.get(17), 71);
  assert.equal(map.has(33), false);
});

test("scoreMeasure が無いデータは measure を楽譜上の小節番号として扱う", () => {
  const map = roundTrip([{ measure: 4, score: 55 }]);
  assert.equal(map.get(4), 55);
});

test("同じ楽譜上の小節に複数回の演奏が写る場合は低いスコアを残す", () => {
  const map = roundTrip([
    { measure: 1, scoreMeasure: 1, score: 90 },
    { measure: 17, scoreMeasure: 1, score: 40 },
  ]);
  assert.equal(map.get(1), 40);
});

test("判定保留と採点済みが同じ楽譜上の小節に写る場合は採点済みを残す", () => {
  const map = roundTrip([
    { measure: 1, scoreMeasure: 1, score: null },
    { measure: 17, scoreMeasure: 1, score: 55 },
  ]);
  assert.equal(map.get(1), 55);
});

test("measureScores が空なら対応表も空", () => {
  assert.equal(roundTrip([]).size, 0);
});

test("0点は判定保留に化けない", () => {
  const map = roundTrip([{ measure: 1, score: 0 }]);
  assert.equal(map.get(1), 0);
});
