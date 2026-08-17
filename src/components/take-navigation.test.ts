import assert from "node:assert/strict";
import test from "node:test";

import { takeNeighbors, type TakeNavItem } from "./take-navigation";

/** 録音日時の昇順（古い順）に3件。API の `listTakesBySong` もこの順で返す。 */
const takes: TakeNavItem[] = [
  { id: "take_a", label: "テイク1", recordedAt: "2026-08-15T10:00:00.000Z" },
  { id: "take_b", label: "テイク2", recordedAt: "2026-08-16T10:00:00.000Z" },
  { id: "take_c", label: "テイク3", recordedAt: "2026-08-17T10:00:00.000Z" },
];

test("前は古いテイク、次は新しいテイク", () => {
  const { prev, next } = takeNeighbors(takes, "take_b");
  assert.equal(prev?.id, "take_a");
  assert.equal(next?.id, "take_c");
});

test("最も古いテイクに前は無い", () => {
  const { prev, next } = takeNeighbors(takes, "take_a");
  assert.equal(prev, null);
  assert.equal(next?.id, "take_b");
});

test("最も新しいテイクに次は無い", () => {
  const { prev, next } = takeNeighbors(takes, "take_c");
  assert.equal(prev?.id, "take_b");
  assert.equal(next, null);
});

test("テイクが1件だけなら前も次も無い", () => {
  const { prev, next } = takeNeighbors([takes[0]], "take_a");
  assert.equal(prev, null);
  assert.equal(next, null);
});

test("一覧が空でも落ちず、前も次も無い", () => {
  const { prev, next } = takeNeighbors([], "take_a");
  assert.equal(prev, null);
  assert.equal(next, null);
});

test("現在のテイクが一覧に無ければ前も次も無い", () => {
  // 曲情報の取得が未完了・失敗した場合や、作成直後で一覧に載っていない場合。
  // ここで隣を推測すると、無関係なテイクへ飛ばす導線になる。
  const { prev, next } = takeNeighbors(takes, "take_unknown");
  assert.equal(prev, null);
  assert.equal(next, null);
});

test("未ソートの入力でも録音日時で並べ直してから隣を選ぶ", () => {
  // サーバの並び順に暗黙に依存しない。listTakesBySong は昇順だが、
  // それが変わった日に前後が静かに入れ替わるのを防ぐ。
  const shuffled = [takes[2], takes[0], takes[1]];
  const { prev, next } = takeNeighbors(shuffled, "take_b");
  assert.equal(prev?.id, "take_a");
  assert.equal(next?.id, "take_c");
});

test("録音日時が同値なら id で決定的に並ぶ", () => {
  const sameInstant: TakeNavItem[] = [
    { id: "take_z", label: "後", recordedAt: "2026-08-16T10:00:00.000Z" },
    { id: "take_a", label: "先", recordedAt: "2026-08-16T10:00:00.000Z" },
  ];
  assert.equal(takeNeighbors(sameInstant, "take_z").prev?.id, "take_a");
  assert.equal(takeNeighbors(sameInstant, "take_a").next?.id, "take_z");
  // 入力順を変えても同じ結果になる（決定的であること）。
  const reversed = [sameInstant[1], sameInstant[0]];
  assert.equal(takeNeighbors(reversed, "take_z").prev?.id, "take_a");
});
