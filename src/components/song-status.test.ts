import assert from "node:assert/strict";
import test from "node:test";

import { scoreStatusColor, scoreStatusLabel } from "./song-status";

test("PDFドラフトは状態より優先して OMRドラフトと出す", () => {
  // scoreSource が pdf のときは status が ready でも「正確な楽譜ではない」ことを
  // 先に伝える必要がある（差し替えを促す対象）。
  assert.equal(scoreStatusLabel("ready", "pdf"), "OMRドラフト");
  assert.equal(scoreStatusLabel("awaiting_score", "pdf"), "OMRドラフト");
});

test("各状態に専用のラベルがある", () => {
  assert.equal(scoreStatusLabel("ready", "musicxml"), "解析済み");
  assert.equal(scoreStatusLabel("parsing_score", null), "楽譜を解析中");
  assert.equal(scoreStatusLabel("converting_score", null), "PDF変換中");
  assert.equal(scoreStatusLabel("reviewing_score", null), "変換結果の確認待ち");
  assert.equal(scoreStatusLabel("awaiting_score", null), "楽譜待ち");
});

test("変換失敗は準備中と混ぜない", () => {
  // 失敗を「準備中」と出すと、終わらない処理を待たせることになる。
  assert.equal(scoreStatusLabel("omr_failed", null), "PDF変換失敗");
  assert.notEqual(scoreStatusLabel("omr_failed", null), scoreStatusLabel("converting_score", null));
});

test("失敗と確認待ちは色でも区別する", () => {
  const failed = scoreStatusColor("omr_failed", null);
  const reviewing = scoreStatusColor("reviewing_score", null);
  const ready = scoreStatusColor("ready", "musicxml");
  const waiting = scoreStatusColor("awaiting_score", null);
  assert.equal(new Set([failed, reviewing, ready, waiting]).size, 4);
});

test("PDFドラフトは ready でも確認を促す色にする", () => {
  assert.equal(scoreStatusColor("ready", "pdf"), scoreStatusColor("reviewing_score", null));
});
