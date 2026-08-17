import type { MetricKey } from "@/lib/mock/types";
import type { MetricEvaluationDoc } from "./types";

/**
 * ローカルの決定論スタブ（`LEDGERLINES_AZURE_EMULATOR=true` かつ
 * `LEDGERLINES_DETERMINISTIC_ANALYSIS=true`）がテイクに書き込む解析結果。
 *
 * `queue.ts` の中に直接書いていたときは `metrics` だけを埋めて
 * `metricEvaluations`（#29 で入った指標ごとの採点ポリシー）を書き忘れており、
 * `POST /api/takes/{takeId}/coach` が常に
 * `400 analysis has no calibrated metrics for coaching` を返していた（#44）。
 *
 * 純粋な関数として切り出してあるのは、**metrics と metricEvaluations が
 * 食い違わないこと**をテストで固定するため。スタブが本物の形から取り残される
 * のがこのバグの本質なので、`Record<MetricKey, ...>` で全指標を型で要求し、
 * 指標が増えたときにビルドで気づけるようにしている。
 */
export interface DeterministicAnalysis {
  overallScore: number;
  metrics: Record<MetricKey, number | null>;
  metricEvaluations: Record<MetricKey, MetricEvaluationDoc>;
  metricsNAReason: Partial<Record<MetricKey, string>>;
}

/** ペダルは測っていない。理由文は NA 理由と evaluation で共有して食い違いを防ぐ。 */
const PEDAL_UNAVAILABLE_REASON = "deterministic local analysis does not measure pedal";

/**
 * 採点済みの指標に付ける evaluation。
 *
 * `confidence` は `null` にしてある。スタブは何も測っていないので報告できる確度を
 * 持たない——`1` を書くと「完全に確信がある測定結果」を騙ることになる。
 */
function scored(): MetricEvaluationDoc {
  return {
    status: "scored",
    confidence: null,
    reasonCode: "DETERMINISTIC_LOCAL_STUB",
    reason: "ローカルの決定論スタブが返す固定値です。実際の演奏を測っていません。",
    evidence: {},
  };
}

/** 呼び出しごとに新しいオブジェクトを返す（呼び出し側の書き換えが波及しないように）。 */
export function deterministicAnalysisResult(): DeterministicAnalysis {
  return {
    overallScore: 79,
    metrics: { pitch: 82, rhythm: 78, tempo: 80, dynamics: 75, pedal: null },
    metricEvaluations: {
      pitch: scored(),
      rhythm: scored(),
      tempo: scored(),
      dynamics: scored(),
      pedal: {
        status: "unavailable",
        confidence: null,
        reasonCode: "DETERMINISTIC_STUB_NO_PEDAL",
        reason: PEDAL_UNAVAILABLE_REASON,
        evidence: {},
      },
    },
    metricsNAReason: { pedal: PEDAL_UNAVAILABLE_REASON },
  };
}
