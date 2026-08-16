import assert from "node:assert/strict";
import test from "node:test";

import { isScoreProgressTerminal, scoreProgressFailureMessage } from "./score-progress";

test("parsing_score keeps the stream open", () => {
  assert.equal(isScoreProgressTerminal("parsing_score"), false);
});

test("ready ends the stream", () => {
  assert.equal(isScoreProgressTerminal("ready"), true);
});

test("awaiting_score ends the stream because generation already failed", () => {
  assert.equal(isScoreProgressTerminal("awaiting_score"), true);
});

test("reviewing_score ends the stream because it waits on the user", () => {
  assert.equal(isScoreProgressTerminal("reviewing_score"), true);
});

test("omr_failed ends the stream", () => {
  assert.equal(isScoreProgressTerminal("omr_failed"), true);
});

test("converting_score keeps the stream open until the cap", () => {
  // PDF の OMR は本設計のスコープ外で、azure バックエンドでは進まない。
  // 終端扱いにすると「変換中」を失敗として見せてしまうので、上限打ち切りに任せる。
  assert.equal(isScoreProgressTerminal("converting_score"), false);
});

test("failure message prefers the worker's reason", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "awaiting_score", lastScoreError: "小節線が閉じていません" }),
    "小節線が閉じていません",
  );
});

test("failure message falls back when the worker left no reason", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "awaiting_score" }),
    "楽譜を解析できませんでした。ファイルを確認して、もう一度アップロードしてください。",
  );
});

test("failure message uses omrError for a failed PDF conversion", () => {
  assert.equal(
    scoreProgressFailureMessage({ status: "omr_failed", omrError: "PDFを変換できませんでした" }),
    "PDFを変換できませんでした",
  );
});

test("ready has no failure message", () => {
  assert.equal(scoreProgressFailureMessage({ status: "ready" }), null);
});
