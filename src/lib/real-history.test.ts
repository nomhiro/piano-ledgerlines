import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sortByRecordedAt, sortByRecordedAtDesc, toCoachTake } from "./real-history";
import type { TakeDoc } from "@/lib/server/types";

test("sortByRecordedAt orders takes from oldest to newest", () => {
  const items = [
    { id: "take-latest", recordedAt: "2026-07-24T21:36:00+09:00" },
    { id: "take-earliest", recordedAt: "2026-06-28T21:10:00+09:00" },
    { id: "take-middle", recordedAt: "2026-07-18T22:02:00+09:00" },
  ];

  assert.deepStrictEqual(
    sortByRecordedAt(items).map((item) => item.id),
    ["take-earliest", "take-middle", "take-latest"],
  );
});

test("sortByRecordedAtDesc orders takes from newest to oldest", () => {
  const items = [
    { id: "take-latest", recordedAt: "2026-07-24T21:36:00+09:00" },
    { id: "take-earliest", recordedAt: "2026-06-28T21:10:00+09:00" },
    { id: "take-middle", recordedAt: "2026-07-18T22:02:00+09:00" },
  ];

  assert.deepStrictEqual(
    sortByRecordedAtDesc(items).map((item) => item.id),
    ["take-latest", "take-middle", "take-earliest"],
  );
});

function takeDocFixture(overrides: Partial<TakeDoc> = {}): TakeDoc {
  return {
    id: "take_abc",
    userId: "usr_local_dev",
    songId: "song_abc",
    label: "テイク1",
    recordedAt: "2026-08-14T21:00:00+09:00",
    durationSec: 92,
    requestedMeasureRange: [1, 8],
    playedMeasureRange: null,
    requestedTempo: 96,
    inputKind: "audio",
    contentType: "audio/webm",
    status: "completed",
    progress: 1,
    failure: null,
    overallScore: null,
    metrics: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
    metricConfidence: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
    metricEvaluations: {},
    metricsNAReason: {},
    evaluation: null,
    measureScores: [],
    issues: [],
    aiReview: null,
    analysis: null,
    memo: "",
    createdAt: "2026-08-14T21:00:00+09:00",
    updatedAt: "2026-08-14T21:05:00+09:00",
    ...overrides,
  };
}

test("toCoachTake exposes only fields CoachView reads", () => {
  const result = toCoachTake(takeDocFixture());

  assert.deepStrictEqual(Object.keys(result).sort(), [
    "aiReview",
    "id",
    "label",
    "recordedAt",
  ]);
  assert.strictEqual(result.id, "take_abc");
  assert.strictEqual(result.label, "テイク1");
});

test("toCoachTake never fabricates a score field", () => {
  const result = toCoachTake(takeDocFixture()) as Record<string, unknown>;

  assert.strictEqual("overallScore" in result, false);
  assert.strictEqual("metrics" in result, false);
  assert.strictEqual("measureScores" in result, false);
});

test("real-history no longer exposes a score-fabricating adapter", async () => {
  const mod: Record<string, unknown> = await import("./real-history");

  assert.strictEqual("toHistoryTake" in mod, false);
  assert.strictEqual("metricsFromDoc" in mod, false);

  // Module-shape checks above only catch a regression named `toHistoryTake` /
  // `metricsFromDoc`. The actual invariant this whole plan protects is: no
  // function in this file — whatever it's called — may fall a withheld score
  // or metric back to `0` via `?? 0`. Read the source itself to guard that,
  // resolved relative to this test file so it doesn't depend on process cwd.
  const sourcePath = join(import.meta.dirname, "real-history.ts");
  const source = readFileSync(sourcePath, "utf8");
  const scoreFabricationPattern = /\b(?:overallScore|score|pitch|rhythm|tempo|dynamics|pedal)\w*\s*\?\?\s*0\b/;

  assert.strictEqual(
    scoreFabricationPattern.test(source),
    false,
    "real-history.ts contains a `?? 0` fallback on a score/metric-shaped identifier. " +
      "This is the exact bug this file exists to prevent: a withheld/unavailable score " +
      "must stay null so the UI can render a withheld state, not silently become a " +
      "fabricated 0. If this assertion fired, some function — even one not named " +
      "toHistoryTake/metricsFromDoc — reintroduced that fallback.",
  );
});
