import assert from "node:assert/strict";
import test from "node:test";

import { sortByRecordedAt, toCoachTake } from "./real-history";
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
