import assert from "node:assert/strict";
import test from "node:test";

import {
  issuesForSelection,
  performanceMeasuresFor,
  printedMeasureOf,
} from "./measure-selection";

/** 繰り返しが無い曲: 演奏順と楽譜上の番号が一致する。 */
const withoutRepeats = [
  { measure: 1, scoreMeasure: 1 },
  { measure: 2, scoreMeasure: 2 },
  { measure: 3, scoreMeasure: 3 },
];

/** 繰り返しを展開した曲: 演奏順 1・3 が同じ楽譜上の小節 1 に印刷される。 */
const withRepeats = [
  { measure: 1, scoreMeasure: 1 },
  { measure: 2, scoreMeasure: 2 },
  { measure: 3, scoreMeasure: 1 },
  { measure: 4, scoreMeasure: 2 },
];

const issues = [
  { id: "i1", measures: [1], summary: "1小節" },
  { id: "i2", measures: [2, 3], summary: "2〜3小節" },
  { id: "i3", measures: [4], summary: "4小節" },
];

test("楽譜上の番号は scoreMeasure、無ければ演奏順にフォールバックする", () => {
  assert.equal(printedMeasureOf({ measure: 3, scoreMeasure: 1 }), 1);
  assert.equal(printedMeasureOf({ measure: 3 }), 3);
});

test("繰り返しが無ければ楽譜上の小節は演奏順1つに対応する", () => {
  assert.deepEqual(performanceMeasuresFor(withoutRepeats, 2), [2]);
});

test("繰り返しを展開すると楽譜上の1小節が複数の演奏順小節に対応する", () => {
  assert.deepEqual(performanceMeasuresFor(withRepeats, 1), [1, 3]);
  assert.deepEqual(performanceMeasuresFor(withRepeats, 2), [2, 4]);
});

test("scoreMeasure を持たないデータは演奏順で突き合わせる", () => {
  const noScoreMeasure = [{ measure: 1 }, { measure: 2 }];
  assert.deepEqual(performanceMeasuresFor(noScoreMeasure, 2), [2]);
});

test("存在しない楽譜上の小節を選んだら対応する演奏順小節は無い", () => {
  assert.deepEqual(performanceMeasuresFor(withoutRepeats, 99), []);
});

test("選択が null なら演奏順小節を絞らない（空を返す）", () => {
  // 絞り込みの有無は issuesForSelection が判断する。ここでは
  // 「選択されていない」を「対応小節なし」として素直に返す。
  assert.deepEqual(performanceMeasuresFor(withoutRepeats, null), []);
});

test("選択が null のときは指摘事項を絞り込まない", () => {
  // 「絞り込みなし」と「該当0件」を混同すると、未選択の画面が空に見える。
  assert.deepEqual(issuesForSelection(issues, withoutRepeats, null), issues);
});

test("選択した小節を含む指摘事項だけを返す", () => {
  const filtered = issuesForSelection(issues, withoutRepeats, 3);
  assert.deepEqual(
    filtered.map((i) => i.id),
    ["i2"],
  );
});

test("複数小節にまたがる指摘は、そのどれかが選ばれていれば残る", () => {
  assert.deepEqual(
    issuesForSelection(issues, withoutRepeats, 2).map((i) => i.id),
    ["i2"],
  );
});

test("繰り返し展開時は、その楽譜小節に写るすべての演奏順小節の指摘を集める", () => {
  // 楽譜上の小節 1 には演奏順 1 と 3 が写る。i1（measures [1]）と
  // i2（measures [2,3]）の両方が該当する。
  assert.deepEqual(
    issuesForSelection(issues, withRepeats, 1).map((i) => i.id),
    ["i1", "i2"],
  );
});

test("選択した小節に指摘が無ければ空を返す", () => {
  const only4 = [{ id: "i3", measures: [4], summary: "4小節" }];
  assert.deepEqual(issuesForSelection(only4, withoutRepeats, 1), []);
});

test("指摘事項の順序は元の並びを保つ", () => {
  const reordered = issuesForSelection(
    [issues[2], issues[0], issues[1]],
    withRepeats,
    1,
  );
  assert.deepEqual(
    reordered.map((i) => i.id),
    ["i1", "i2"],
  );
});
