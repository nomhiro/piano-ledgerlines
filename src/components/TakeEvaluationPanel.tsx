import { AlertTriangle } from "lucide-react";
import { Badge, Card, CardTitle, MetricBar, ScoreRing } from "@/components/ui";
import { METRIC_LABELS, type MetricKey } from "@/lib/mock/types";

const SEVERITY_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#64748b",
};

const STATUS_LABEL: Record<string, string> = {
  scored: "採点済み",
  reference: "参考値",
  withheld: "判定保留",
  unavailable: "測定対象外",
};

export interface TakeEvaluationData {
  id: string;
  label: string;
  status: string;
  failure: { message: string } | null;
  overallScore: number | null;
  metrics: Record<string, number | null> | null;
  // `TakeDoc` 側は Partial<Record<MetricKey, ...>>、`ApiTakeDetail` 側は
  // Record<string, ...>。両方を受けるため Partial で緩める（値が undefined になり得る）。
  metricEvaluations: Partial<Record<string, { status: string; confidence: number | null; reason: string | null }>>;
  metricsNAReason: Partial<Record<string, string>>;
  evaluation: { status: string; reason: string | null } | null;
  measureScores: { measure: number; score: number | null }[];
  issues: {
    id: string;
    severity: "high" | "medium" | "low";
    measures: number[];
    summary: string;
    metric: string;
    observation?: string;
    practiceAction?: string;
  }[];
}

export default function TakeEvaluationPanel({ take }: { take: TakeEvaluationData }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="flex flex-col items-center justify-center gap-3 p-8 lg:col-span-1">
          {take.overallScore !== null ? (
            <ScoreRing score={take.overallScore} label="総合スコア" size={140} />
          ) : take.evaluation?.status === "withheld" ? (
            <div className="space-y-2 text-center">
              <div className="text-lg font-semibold text-amber-300">判定保留</div>
              <p className="max-w-xs text-xs leading-relaxed text-[var(--muted)]">
                {take.evaluation.reason}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[var(--muted)]">総合スコア未算出</p>
          )}
          {take.failure && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {take.failure.message}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle title="5指標" />
          <div className="space-y-4 p-5">
            {take.metrics &&
              (Object.keys(METRIC_LABELS) as MetricKey[]).map((key) => {
                const value = take.metrics?.[key];
                const evaluation = take.metricEvaluations?.[key];
                if (value === null || value === undefined) {
                  return (
                    <div key={key} className="flex items-start justify-between gap-4 text-xs">
                      <span className="text-[var(--muted)]">{METRIC_LABELS[key]}</span>
                      <span className="max-w-md text-right text-[var(--muted)]">
                        {STATUS_LABEL[evaluation?.status ?? ""] ?? "算出不可"}
                        {(evaluation?.reason ?? take.metricsNAReason[key])
                          ? `（${evaluation?.reason ?? take.metricsNAReason[key]}）`
                          : ""}
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={key}>
                    <MetricBar label={METRIC_LABELS[key]} value={value} />
                    {evaluation?.status === "reference" && (
                      <p className="mt-1 text-right text-[11px] text-amber-300">
                        参考値
                        {evaluation.confidence !== null
                          ? ` ・ 対応品質 ${Math.round(evaluation.confidence * 100)}%`
                          : ""}
                        {evaluation.reason ? ` — ${evaluation.reason}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            {!take.metrics && (
              <p className="text-sm text-[var(--muted)]">まだ指標がありません（解析中または未完了）。</p>
            )}
          </div>
        </Card>
      </div>

      {take.issues.length > 0 && (
        <Card>
          <CardTitle title="指摘事項" />
          <div className="space-y-2 p-5">
            {take.issues.map((issue) => (
              <div
                key={issue.id}
                className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs"
              >
                <Badge color={SEVERITY_COLOR[issue.severity] ?? "#64748b"}>{issue.severity}</Badge>
                <div>
                  <div>{issue.summary}</div>
                  <div className="mt-1 text-[var(--muted)]">
                    小節 {issue.measures.join(", ")} ・{" "}
                    {METRIC_LABELS[issue.metric as MetricKey] ?? issue.metric}
                  </div>
                  {issue.observation && (
                    <div className="mt-2 text-[var(--muted)]">根拠: {issue.observation}</div>
                  )}
                  {issue.practiceAction && (
                    <div className="mt-1 text-violet-200">練習: {issue.practiceAction}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {take.measureScores.length > 0 && (
        <Card>
          <CardTitle title="小節ごとのスコア" />
          <div className="flex flex-wrap gap-1.5 p-5">
            {take.measureScores.map((m) => (
              <div
                key={m.measure}
                title={
                  m.score === null
                    ? `小節 ${m.measure}: 判定保留`
                    : `小節 ${m.measure}: ${m.score}`
                }
                className="flex h-8 w-8 items-center justify-center rounded text-[10px] tabular-nums"
                style={{
                  backgroundColor:
                    m.score === null
                      ? "#2a3145"
                      : m.score >= 80
                        ? "#16653450"
                        : m.score >= 60
                          ? "#a1650150"
                          : "#7f1d1d50",
                  backgroundImage:
                    m.score === null
                      ? "repeating-linear-gradient(135deg, transparent, transparent 3px, #475569 3px, #475569 4px)"
                      : undefined,
                }}
              >
                {m.measure}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
