"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Sparkles, Play, ChevronRight, AlertTriangle } from "lucide-react";
import type { Song, Take, Severity } from "@/lib/mock/types";
import {
  ISSUE_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  METRIC_DESCRIPTIONS,
} from "@/lib/mock/types";
import { Badge, Card, CardTitle, MetricBar, ScoreRing } from "@/components/ui";
import MeasureHeatmap from "@/components/MeasureHeatmap";
import PianoRoll from "@/components/PianoRoll";
import ScoreView from "@/components/ScoreView";
import { DynamicsChart, MetricRadar, TempoCurveChart } from "@/components/charts";
import {
  formatDateTime,
  formatDuration,
  severityColor,
  severityLabel,
  signed,
} from "@/lib/format";

export default function TakeAnalysisView({
  song,
  take,
  prev,
  first,
}: {
  song: Song;
  take: Take;
  prev?: Take;
  first: Take;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [sevFilter, setSevFilter] = useState<Severity | "all">("all");

  const radarData = METRIC_KEYS.map((k) => ({
    metric: METRIC_LABELS[k],
    current: take.metrics[k],
    ...(prev ? { previous: prev.metrics[k] } : {}),
  }));

  const issues = take.issues
    .filter((i) => (sevFilter === "all" ? true : i.severity === sevFilter))
    .filter((i) => (selected === null ? true : i.measure === selected))
    .sort((a, b) => a.measure - b.measure);

  const delta = prev ? Math.round((take.overallScore - prev.overallScore) * 10) / 10 : null;

  return (
    <div>
      <Link
        href={`/songs/${song.id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        <ArrowLeft size={14} /> {song.title} に戻る
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">分析結果 — {take.label}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {formatDateTime(take.recordedAt)} ・ {take.measureRange[0]}〜{take.measureRange[1]}小節
            ・ ♩={take.tempoBpm} ・ {formatDuration(take.durationSec)}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
            <Play size={15} /> 録音を再生
          </button>
          <Link
            href={`/coach?song=${song.id}`}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Sparkles size={15} /> AIコーチに相談
          </Link>
        </div>
      </div>

      {/* --- AI 講評 --- */}
      <Card className="mb-5 border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-transparent">
        <div className="flex flex-wrap items-start gap-4 p-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
            <Sparkles size={19} className="text-violet-300" />
          </div>
          <div className="min-w-[260px] flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-base font-semibold">{take.aiReview.headline}</span>
            </div>
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              {take.aiReview.summary}
            </p>
            <Link
              href={`/coach?song=${song.id}`}
              className="mt-3 inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
            >
              練習メニューとチャット相談へ <ChevronRight size={13} />
            </Link>
          </div>
        </div>
      </Card>

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <CardTitle title="総合スコア" />
          <div className="flex flex-col items-center gap-3 p-5">
            <ScoreRing score={take.overallScore} size={130} />
            {delta !== null && (
              <div className="text-xs text-[var(--muted)]">
                前回 {prev!.overallScore.toFixed(1)} →{" "}
                <span className={delta >= 0 ? "text-green-400" : "text-red-400"}>
                  {signed(delta)} 点
                </span>
              </div>
            )}
            <div className="w-full space-y-2.5 pt-2">
              {METRIC_KEYS.map((k) => (
                <MetricBar
                  key={k}
                  label={METRIC_LABELS[k]}
                  value={take.metrics[k]}
                  delta={
                    prev ? Math.round((take.metrics[k] - prev.metrics[k]) * 10) / 10 : undefined
                  }
                  hint={METRIC_DESCRIPTIONS[k]}
                />
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle title="6指標バランス" subtitle={prev ? "前回テイクと比較" : undefined} />
          <div className="p-4">
            <MetricRadar data={radarData} />
          </div>
        </Card>

        <Card>
          <CardTitle title="良かった点 / 改善点" subtitle="AIが分析結果から抽出" />
          <div className="space-y-4 p-5 text-xs">
            <div>
              <div className="mb-2 text-[11px] font-semibold text-green-400">良かった点</div>
              <ul className="space-y-1.5">
                {take.aiReview.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed text-[var(--muted)]">
                    <span className="text-green-400">✓</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold text-amber-400">改善点</div>
              <ul className="space-y-1.5">
                {take.aiReview.improvements.map((s, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed text-[var(--muted)]">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-400" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      </div>

      {/* --- 楽譜 + ヒートマップ --- */}
      <div className="mb-5 grid gap-5">
        <Card>
          <CardTitle
            title="楽譜ビュー"
            subtitle="小節スコアを楽譜に重ねて表示。クリックで詳細を絞り込みます。"
            right={
              selected !== null && (
                <button
                  onClick={() => setSelected(null)}
                  className="text-xs text-violet-300"
                >
                  {selected}小節の選択を解除
                </button>
              )
            }
          />
          <div className="p-4">
            <ScoreView
              scoreUrl={song.scoreUrl ?? "/scores/etude-in-a-minor.musicxml"}
              measureScores={take.measureScores}
              onSelectMeasure={(m) => setSelected(selected === m ? null : m)}
              selected={selected}
              footnote="※ デモ用サンプル楽譜（16小節）に、分析結果の小節スコアを色で重ねています。本実装ではアップロードされたMusicXMLをそのまま表示します。"
            />
          </div>
        </Card>

        <Card>
          <CardTitle title="小節別ヒートマップ" subtitle="どの小節が弱いか一目で分かります" />
          <div className="p-5">
            <MeasureHeatmap
              measures={take.measureScores}
              compare={first.id === take.id ? undefined : first.measureScores}
              onSelect={(m) => setSelected(selected === m ? null : m)}
              selected={selected}
            />
          </div>
        </Card>
      </div>

      {/* --- ピアノロール --- */}
      <Card className="mb-5">
        <CardTitle
          title="演奏 vs 楽譜（ピアノロール）"
          subtitle="AI採譜した演奏音符と楽譜音符のアライメント結果"
        />
        <div className="p-5">
          <PianoRoll
            notes={
              selected === null ? take.roll : take.roll.filter((n) => n.measure === selected)
            }
          />
        </div>
      </Card>

      {/* --- テンポ / ダイナミクス --- */}
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle
            title="テンポ推移"
            subtitle="小節ごとの実測テンポ。走り・もたつきを検出します。"
          />
          <div className="p-4">
            <TempoCurveChart data={take.tempoCurve} />
          </div>
        </Card>
        <Card>
          <CardTitle
            title="ダイナミクス"
            subtitle="楽譜の強弱指示（点線）と実測音量の比較"
          />
          <div className="p-4">
            <DynamicsChart data={take.dynamicsCurve} />
          </div>
        </Card>
      </div>

      {/* --- 指摘一覧 --- */}
      <Card>
        <CardTitle
          title={`検出された指摘（${issues.length}件）`}
          subtitle={selected !== null ? `${selected}小節に絞り込み中` : undefined}
          right={
            <div className="flex gap-1.5">
              {(["all", "high", "medium", "low"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSevFilter(s)}
                  className="rounded-md px-2.5 py-1 text-[11px]"
                  style={{
                    border: `1px solid ${
                      sevFilter === s
                        ? s === "all"
                          ? "#8d97ad"
                          : severityColor[s]
                        : "#2a3145"
                    }`,
                    color:
                      sevFilter === s
                        ? s === "all"
                          ? "#e8ecf5"
                          : severityColor[s]
                        : "#8d97ad",
                  }}
                >
                  {s === "all" ? "すべて" : severityLabel[s]}
                </button>
              ))}
            </div>
          }
        />
        <div className="divide-y divide-[var(--border)]">
          {issues.length === 0 && (
            <p className="px-5 py-6 text-xs text-[var(--muted)]">
              条件に一致する指摘はありません。
            </p>
          )}
          {issues.map((i) => (
            <div key={i.id} className="flex gap-4 px-5 py-4">
              <button
                onClick={() => setSelected(selected === i.measure ? null : i.measure)}
                className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border text-[10px]"
                style={{
                  borderColor: severityColor[i.severity],
                  backgroundColor: `${severityColor[i.severity]}18`,
                  color: severityColor[i.severity],
                }}
              >
                <span className="text-sm font-semibold">{i.measure}</span>
                <span>小節</span>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{i.title}</span>
                  <Badge color={severityColor[i.severity]}>{severityLabel[i.severity]}</Badge>
                  <Badge color="#64748b">{ISSUE_LABELS[i.type]}</Badge>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">{i.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4 text-[11px] leading-relaxed text-[var(--muted)]">
        <strong className="text-[var(--foreground)]">分析の前提：</strong>{" "}
        {take.aiReview.context}
      </div>
    </div>
  );
}
