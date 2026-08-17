import assert from "node:assert/strict";
import test from "node:test";

import { METRIC_KEYS } from "@/lib/mock/types";
import { deterministicAnalysisResult } from "./deterministic-analysis";

test("5指標すべてに metrics と metricEvaluations の両方が揃っている", () => {
  const result = deterministicAnalysisResult();
  for (const key of METRIC_KEYS) {
    assert.ok(key in result.metrics, `metrics に ${key} が無い`);
    assert.ok(key in result.metricEvaluations, `metricEvaluations に ${key} が無い`);
  }
});

test("値がある指標は scored、値が null の指標は scored でない", () => {
  // このバグの本体は「metrics は埋まっているのに metricEvaluations が空」だった。
  // 両者が食い違うこと自体を禁じる（#44）。
  const { metrics, metricEvaluations } = deterministicAnalysisResult();
  for (const key of METRIC_KEYS) {
    const hasValue = metrics[key] !== null;
    const scored = metricEvaluations[key].status === "scored";
    assert.equal(scored, hasValue, `${key}: 値の有無(${hasValue})と scored(${scored})が食い違う`);
  }
});

test("採点していない指標には理由コードと理由文が付く", () => {
  const { metricEvaluations } = deterministicAnalysisResult();
  for (const key of METRIC_KEYS) {
    const evaluation = metricEvaluations[key];
    if (evaluation.status === "scored") continue;
    assert.ok(evaluation.reasonCode, `${key}: reasonCode が無い`);
    assert.ok(evaluation.reason, `${key}: reason が無い`);
  }
});

test("metricsNAReason は採点していない指標にだけ付き、理由文が evaluation と一致する", () => {
  // 同じ内容を2箇所に書くと片方だけ古くなる。文字列が一致することを固定する。
  const { metrics, metricEvaluations, metricsNAReason } = deterministicAnalysisResult();
  for (const [key, reason] of Object.entries(metricsNAReason)) {
    const metricKey = key as (typeof METRIC_KEYS)[number];
    assert.equal(metrics[metricKey], null, `${key}: 値があるのに NA 理由が付いている`);
    assert.notEqual(metricEvaluations[metricKey].status, "scored");
    assert.equal(reason, metricEvaluations[metricKey].reason);
  }
});

test("AIコーチの受入条件を満たす（scored な指標が少なくとも1つある）", () => {
  // coach/route.ts:25-31 が要求する条件をそのまま再現する。これが false になると
  // `400 analysis has no calibrated metrics for coaching` になる。
  const { metrics, metricEvaluations } = deterministicAnalysisResult();
  const scoredMetrics = Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [
      key,
      metricEvaluations[key as (typeof METRIC_KEYS)[number]].status === "scored" ? value : null,
    ]),
  );
  assert.ok(
    Object.values(scoredMetrics).some((value) => value !== null),
    "scored な指標が無いため AIコーチが 400 になる",
  );
});

test("総合スコアは scored な指標が1つでもある限り出す", () => {
  const { overallScore } = deterministicAnalysisResult();
  assert.equal(typeof overallScore, "number");
});

test("呼び出しごとに同じ値を返す（決定論スタブなので）", () => {
  assert.deepEqual(deterministicAnalysisResult(), deterministicAnalysisResult());
});

test("返り値を書き換えても次の呼び出しに影響しない", () => {
  // updateTake に渡す前に呼び出し側が触っても、共有状態を壊さない。
  const first = deterministicAnalysisResult();
  first.metrics.pitch = 1;
  first.metricEvaluations.pitch.status = "withheld";
  const second = deterministicAnalysisResult();
  assert.notEqual(second.metrics.pitch, 1);
  assert.equal(second.metricEvaluations.pitch.status, "scored");
});
