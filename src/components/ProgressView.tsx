"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, TrendingUp, AlertTriangle } from "lucide-react";
import type { Song, Take } from "@/lib/mock/types";
import { METRIC_KEYS, METRIC_LABELS } from "@/lib/mock/types";
import { Badge, Card, CardTitle, MetricBar, ScoreRing, Stat } from "@/components/ui";
import SongSelector from "@/components/SongSelector";
import MeasureHeatmap from "@/components/MeasureHeatmap";
import { MeasureDeltaBar, MetricRadar, MultiMetricTrend, ScoreTrend } from "@/components/charts";
import { formatDate, formatDateTime, signed } from "@/lib/format";

const SERIES_COLORS: Record<string, string> = {
  pitch: "#38bdf8",
  rhythm: "#a78bfa",
  tempo: "#22c55e",
  dynamics: "#f472b6",
  pedal: "#f59e0b",
};

export default function ProgressView({
  songs,
  song,
  takes,
  stagnant,
}: {
  songs: Song[];
  song: Song;
  takes: Take[];
  stagnant: { measure: number; delta: number; score: number }[];
}) {
  const [aId, setAId] = useState(takes[0].id);
  const [bId, setBId] = useState(takes[takes.length - 1].id);
  const a = takes.find((t) => t.id === aId)!;
  const b = takes.find((t) => t.id === bId)!;

  const trend = takes.map((t) => ({
    label: formatDate(t.recordedAt),
    score: t.overallScore,
  }));

  const metricTrend = takes.map((t) => {
    const row: Record<string, string | number> = { label: formatDate(t.recordedAt) };
    for (const k of METRIC_KEYS) row[k] = t.metrics[k];
    return row;
  });

  // 共通の小節だけを比較対象にする
  const aMap = new Map(a.measureScores.map((m) => [m.measure, m.score]));
  const deltaByMeasure = b.measureScores
    .filter((m) => aMap.has(m.measure))
    .map((m) => ({
      measure: m.measure,
      delta: Math.round((m.score - aMap.get(m.measure)!) * 10) / 10,
    }));

  const radarData = METRIC_KEYS.map((k) => ({
    metric: METRIC_LABELS[k],
    current: b.metrics[k],
    previous: a.metrics[k],
  }));

  const improved = deltaByMeasure.filter((d) => d.delta >= 5).length;
  const stalled = deltaByMeasure.filter((d) => d.delta < 3).length;
  const worsened = deltaByMeasure.filter((d) => d.delta < 0).length;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">履歴・比較</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            過去の自分と比べる。伸びている箇所と、止まっている箇所を切り分けます。
          </p>
        </div>
        <SongSelector songs={songs} current={song.id} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="テイク数" value={takes.length} unit="件" />
        <Stat
          label="初回からの伸び"
          value={signed(
            Math.round(
              (takes[takes.length - 1].overallScore - takes[0].overallScore) * 10,
            ) / 10,
          )}
          unit="点"
        />
        <Stat label="改善した小節" value={improved} unit={`/ ${deltaByMeasure.length}`} />
        <Stat label="停滞している小節" value={stalled} unit={`/ ${deltaByMeasure.length}`} />
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle title="総合スコアの推移" subtitle="録音するたびに記録されます" />
          <div className="p-4">
            <ScoreTrend data={trend} height={240} />
          </div>
        </Card>
        <Card>
          <CardTitle title="6指標それぞれの推移" subtitle="どの能力が伸びているか" />
          <div className="p-4">
            <MultiMetricTrend
              data={metricTrend}
              series={METRIC_KEYS.map((k) => ({
                key: k,
                label: METRIC_LABELS[k],
                color: SERIES_COLORS[k],
              }))}
            />
          </div>
        </Card>
      </div>

      {/* --- A/B 比較 --- */}
      <Card className="mb-5">
        <CardTitle
          title="テイク A/B 比較"
          subtitle="2つの録音を並べて、何が変わったのかを確認します"
        />
        <div className="p-5">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <TakePicker takes={takes} value={aId} onChange={setAId} label="A（比較元）" />
            <ArrowRight size={18} className="text-[var(--muted)]" />
            <TakePicker takes={takes} value={bId} onChange={setBId} label="B（比較先）" />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className="flex items-center justify-around gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5">
              <div className="text-center">
                <ScoreRing score={a.overallScore} size={80} label="A" />
                <div className="mt-2 text-[11px] text-[var(--muted)]">
                  {formatDate(a.recordedAt)} ♩={a.tempoBpm}
                </div>
              </div>
              <div className="text-center">
                <div
                  className={`text-2xl font-bold ${
                    b.overallScore >= a.overallScore ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {signed(Math.round((b.overallScore - a.overallScore) * 10) / 10)}
                </div>
                <div className="text-[10px] text-[var(--muted)]">点</div>
              </div>
              <div className="text-center">
                <ScoreRing score={b.overallScore} size={80} label="B" />
                <div className="mt-2 text-[11px] text-[var(--muted)]">
                  {formatDate(b.recordedAt)} ♩={b.tempoBpm}
                </div>
              </div>
            </div>

            <Card className="bg-[var(--surface-2)]">
              <div className="p-3">
                <MetricRadar data={radarData} />
              </div>
            </Card>

            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5">
              {METRIC_KEYS.map((k) => (
                <MetricBar
                  key={k}
                  label={METRIC_LABELS[k]}
                  value={b.metrics[k]}
                  delta={Math.round((b.metrics[k] - a.metrics[k]) * 10) / 10}
                />
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* --- 小節別の改善 --- */}
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle
            title="小節別の改善量"
            subtitle={`A（${formatDate(a.recordedAt)}）→ B（${formatDate(b.recordedAt)}）`}
          />
          <div className="p-4">
            <MeasureDeltaBar data={deltaByMeasure} />
          </div>
        </Card>
        <Card>
          <CardTitle title="改善ヒートマップ" subtitle="緑＝伸びた / 赤＝悪化した小節" />
          <div className="p-5">
            <MeasureHeatmap
              measures={b.measureScores.filter((m) => aMap.has(m.measure))}
              compare={a.measureScores}
              mode="delta"
            />
          </div>
        </Card>
      </div>

      {/* --- 停滞小節 --- */}
      <Card>
        <CardTitle
          title="停滞している小節"
          subtitle="初回テイクから +3点未満。練習方法の見直しが必要です。"
          right={
            worsened > 0 && (
              <Badge color="#ef4444">
                <AlertTriangle size={10} className="mr-1 inline" />
                悪化 {worsened} 小節
              </Badge>
            )
          }
        />
        <div className="p-5">
          {stagnant.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">停滞している小節はありません。</p>
          ) : (
            <>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {stagnant.slice(0, 6).map((s) => (
                  <div
                    key={s.measure}
                    className="rounded-lg border border-red-500/25 bg-red-500/10 p-4"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-base font-semibold">{s.measure} 小節</span>
                      <span className="text-xs text-red-300">{signed(s.delta)} 点</span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--muted)]">
                      現在のスコア {s.score.toFixed(1)}
                    </div>
                    <div className="mt-2.5 space-y-1">
                      {takes.map((t) => {
                        const ms = t.measureScores.find((m) => m.measure === s.measure);
                        if (!ms) return null;
                        return (
                          <div key={t.id} className="flex items-center gap-2 text-[10px]">
                            <span className="w-9 text-[var(--muted)]">
                              {formatDate(t.recordedAt)}
                            </span>
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                              <div
                                className="h-full rounded-full bg-red-400"
                                style={{ width: `${ms.score}%` }}
                              />
                            </div>
                            <span className="w-6 text-right tabular-nums text-[var(--muted)]">
                              {ms.score.toFixed(0)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-violet-500/25 bg-violet-500/10 p-4">
                <TrendingUp size={16} className="mt-0.5 shrink-0 text-violet-300" />
                <p className="text-xs leading-relaxed">
                  他の小節が平均で伸びているのに、これらの小節だけ横ばい＝
                  <strong>通し練習の中では改善しない</strong>タイプの課題です。
                  <Link href={`/coach?song=${song.id}`} className="ml-1 text-violet-300 underline">
                    AIコーチの分解練習メニュー
                  </Link>
                  を試してください。
                </p>
              </div>
            </>
          )}
        </div>
      </Card>

      <div className="mt-5">
        <h2 className="mb-3 text-sm font-semibold">全テイク</h2>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {[...takes].reverse().map((t) => (
            <Link key={t.id} href={`/takes/${t.id}`}>
              <Card className="flex items-center gap-3 p-4 transition-colors hover:border-violet-500/50">
                <ScoreRing score={t.overallScore} size={52} />
                <div className="min-w-0">
                  <div className="truncate text-sm">{t.label}</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    {formatDateTime(t.recordedAt)}
                  </div>
                  <div className="text-[11px] text-[var(--muted)]">
                    {t.measureRange[0]}〜{t.measureRange[1]}小節 ・ ♩={t.tempoBpm}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function TakePicker({
  takes,
  value,
  onChange,
  label,
}: {
  takes: Take[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] text-[var(--muted)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
      >
        {takes.map((t) => (
          <option key={t.id} value={t.id}>
            {formatDate(t.recordedAt)} — {t.label}（{t.overallScore.toFixed(1)}点）
          </option>
        ))}
      </select>
    </label>
  );
}
