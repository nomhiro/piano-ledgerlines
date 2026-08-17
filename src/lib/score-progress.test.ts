import assert from "node:assert/strict";
import test from "node:test";

import {
  isScoreProgressTerminal,
  scoreProgressFailureMessage,
  scoreProgressStalledMessage,
  scoreProgressStreamErrorMessage,
} from "./score-progress";

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

test("stalled message is null when ready", () => {
  assert.equal(scoreProgressStalledMessage("ready"), null);
});

test("stalled message is null for explicit failures already covered by scoreProgressFailureMessage", () => {
  assert.equal(scoreProgressStalledMessage("omr_failed"), null);
  assert.equal(scoreProgressStalledMessage("awaiting_score"), null);
});

test("stalled message fires when done arrives without a result (worker never finished before the stream cap)", () => {
  assert.equal(
    scoreProgressStalledMessage("parsing_score"),
    "解析が完了しませんでした。時間をおいて曲の詳細をご確認ください。",
  );
  assert.equal(
    scoreProgressStalledMessage("converting_score"),
    "解析が完了しませんでした。時間をおいて曲の詳細をご確認ください。",
  );
});

test("stalled message fires when done arrives while still waiting on a separate flow (reviewing_score)", () => {
  assert.equal(
    scoreProgressStalledMessage("reviewing_score"),
    "解析が完了しませんでした。時間をおいて曲の詳細をご確認ください。",
  );
});

test("stream error message maps NOT_FOUND to a user-facing reason", () => {
  assert.equal(
    scoreProgressStreamErrorMessage({ code: "NOT_FOUND", message: "song not found" }),
    "対象の曲が見つかりませんでした。曲の一覧からやり直してください。",
  );
});

test("stream error message maps INTERNAL to a user-facing reason", () => {
  assert.equal(
    scoreProgressStreamErrorMessage({ code: "INTERNAL", message: "unable to read score progress" }),
    "進捗の確認中にエラーが発生しました。ページを再読み込みしてください。",
  );
});

test("stream error message falls back to a generic reason for a browser-level disconnect", () => {
  assert.equal(
    scoreProgressStreamErrorMessage(null),
    "進捗の取得が中断されました。ページを再読み込みしてください。",
  );
});
