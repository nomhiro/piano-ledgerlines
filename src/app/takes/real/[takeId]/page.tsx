"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardTitle, PageHeader, ScoreRing, MetricBar, Badge } from "@/components/ui";
import { METRIC_LABELS, type MetricKey } from "@/lib/mock/types";
import { getTake, type ApiTakeDetail } from "@/lib/api/client";

const SEVERITY_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#64748b",
};

export default function RealTakeResultPage() {
  const params = useParams<{ takeId: string }>();
  const takeId = params.takeId;
  const [take, setTake] = useState<ApiTakeDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getTake(takeId);
        if (!cancelled) setTake(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [takeId]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!take) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
        <Loader2 size={16} className="animate-spin" /> 読み込み中…
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="分析結果（実データ）"
        description={`テイク ${take.id} ・ 曲 ${take.songId} ・ ステータス: ${take.status}`}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="flex flex-col items-center justify-center gap-3 p-8 lg:col-span-1">
          {take.overallScore !== null ? (
            <ScoreRing score={take.overallScore} label="総合スコア" size={140} />
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
                if (value === null || value === undefined) {
                  return (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span className="text-[var(--muted)]">{METRIC_LABELS[key]}</span>
                      <span className="text-[var(--muted)]">
                        算出不可
                        {take.metricsNAReason[key] ? `（${take.metricsNAReason[key]}）` : ""}
                      </span>
                    </div>
                  );
                }
                return <MetricBar key={key} label={METRIC_LABELS[key]} value={value} />;
              })}
            {!take.metrics && (
              <p className="text-sm text-[var(--muted)]">まだ指標がありません（解析中または未完了）。</p>
            )}
          </div>
        </Card>
      </div>

      {take.issues.length > 0 && (
        <Card className="mt-5">
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
                    小節 {issue.measures.join(", ")} ・ {METRIC_LABELS[issue.metric as MetricKey] ?? issue.metric}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {take.measureScores.length > 0 && (
        <Card className="mt-5">
          <CardTitle title="小節ごとのスコア" />
          <div className="flex flex-wrap gap-1.5 p-5">
            {take.measureScores.map((m) => (
              <div
                key={m.measure}
                title={`小節 ${m.measure}: ${m.score ?? "N/A"}`}
                className="flex h-8 w-8 items-center justify-center rounded text-[10px] tabular-nums"
                style={{
                  backgroundColor:
                    m.score === null ? "#2a3145" : m.score >= 80 ? "#16653450" : m.score >= 60 ? "#a1650150" : "#7f1d1d50",
                }}
              >
                {m.measure}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-5">
        <Link href="/songs/new" className="text-xs text-violet-300 underline underline-offset-2">
          別の曲を登録する
        </Link>
      </div>
    </div>
  );
}
