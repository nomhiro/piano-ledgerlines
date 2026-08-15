"use client";

import { useState } from "react";
import Link from "next/link";
import { Mic, Sparkles, TrendingUp, Users, Target, ChevronRight } from "lucide-react";
import type { Song, Take, MeasureScore } from "@/lib/mock/types";
import { METRIC_KEYS, METRIC_LABELS, METRIC_DESCRIPTIONS, SONG_STATUS_LABELS } from "@/lib/mock/types";
import { Badge, Card, CardTitle, MetricBar, ScoreRing } from "@/components/ui";
import MeasureHeatmap from "@/components/MeasureHeatmap";
import ScoreView from "@/components/ScoreView";
import { daysUntil, formatDateTime, formatDuration, signed } from "@/lib/format";

export default function SongDetailView({
  song,
  takes,
  stagnant,
}: {
  song: Song;
  takes: Take[];
  stagnant: { measure: number; delta: number; score: number }[];
}) {
  const latest = takes[takes.length - 1];
  const prev = takes.length > 1 ? takes[takes.length - 2] : undefined;
  const [selected, setSelected] = useState<number | null>(null);

  const selectedMeasure: MeasureScore | undefined = latest.measureScores.find(
    (m) => m.measure === selected,
  );

  return (
    <div>
      {/* header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{song.title}</h1>
            <Badge color={song.accent}>{SONG_STATUS_LABELS[song.status]}</Badge>
            {song.sharedWithTeacher && <Badge color="#06b6d4">先生と共有中</Badge>}
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {song.composer} ・ {song.period} ・ {song.keySignature} ・ {song.timeSignature} ・ 全
            {song.totalMeasures}小節
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/record?song=${song.id}`}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Mic size={15} /> 録音
          </Link>
          <NavBtn href={`/coach?song=${song.id}`} icon={<Sparkles size={15} />} label="AIコーチ" />
          <NavBtn href={`/progress?song=${song.id}`} icon={<TrendingUp size={15} />} label="履歴・比較" />
          <NavBtn href={`/share?song=${song.id}`} icon={<Users size={15} />} label="先生と共有" />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardTitle
              title="楽譜ビュー"
              subtitle="最新テイクの小節スコアを楽譜に重ねて表示"
              right={
                <span className="text-[11px] text-[var(--muted)]">
                  {formatDateTime(latest.recordedAt)} のテイク
                </span>
              }
            />
            <div className="p-4">
              <ScoreView
                scoreUrl={song.scoreUrl ?? "/scores/etude-in-a-minor.musicxml"}
                measureScores={latest.measureScores}
                onSelectMeasure={setSelected}
                selected={selected}
                footnote="※ デモ用サンプル楽譜（16小節）に、分析結果の小節スコアを色で重ねています。本実装ではアップロードされたMusicXMLをそのまま表示します。"
              />
            </div>
          </Card>

          <Card>
            <CardTitle
              title="小節別ヒートマップ"
              subtitle={`${latest.measureRange[0]}〜${latest.measureRange[1]}小節 / 弱点が一目で分かります`}
            />
            <div className="p-5">
              <MeasureHeatmap
                measures={latest.measureScores}
                compare={takes[0].measureScores}
                onSelect={setSelected}
                selected={selected}
              />
            </div>
          </Card>

          {selectedMeasure && (
            <Card>
              <CardTitle
                title={`${selectedMeasure.measure} 小節の詳細`}
                right={
                  <button
                    onClick={() => setSelected(null)}
                    className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                  >
                    閉じる
                  </button>
                }
              />
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                {METRIC_KEYS.map((k) => (
                  <MetricBar
                    key={k}
                    label={METRIC_LABELS[k]}
                    value={selectedMeasure.metrics[k]}
                    hint={METRIC_DESCRIPTIONS[k]}
                  />
                ))}
              </div>
              <div className="border-t border-[var(--border)] px-5 py-4">
                {latest.issues.filter((i) => i.measure === selectedMeasure.measure).length ===
                0 ? (
                  <p className="text-xs text-[var(--muted)]">
                    この小節で検出された指摘はありません。
                  </p>
                ) : (
                  latest.issues
                    .filter((i) => i.measure === selectedMeasure.measure)
                    .map((i) => (
                      <div key={i.id} className="text-xs">
                        <div className="font-semibold">{i.title}</div>
                        <p className="mt-1 leading-relaxed text-[var(--muted)]">{i.detail}</p>
                      </div>
                    ))
                )}
              </div>
            </Card>
          )}

          <Card>
            <CardTitle title="テイク履歴" subtitle={`${takes.length} 件の録音`} />
            <div className="divide-y divide-[var(--border)]">
              {[...takes].reverse().map((t) => {
                const idx = takes.indexOf(t);
                const before = idx > 0 ? takes[idx - 1] : undefined;
                const delta = before
                  ? Math.round((t.overallScore - before.overallScore) * 10) / 10
                  : null;
                return (
                  <Link
                    key={t.id}
                    href={`/takes/${t.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <ScoreRing score={t.overallScore} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        {t.label}
                        {delta !== null && (
                          <span
                            className={`text-[11px] ${
                              delta >= 0 ? "text-green-400" : "text-red-400"
                            }`}
                          >
                            {signed(delta)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {formatDateTime(t.recordedAt)} ・ {t.measureRange[0]}〜
                        {t.measureRange[1]}小節 ・ ♩={t.tempoBpm} ・{" "}
                        {formatDuration(t.durationSec)} ・ 指摘 {t.issues.length} 件
                      </div>
                      {t.memo && (
                        <div className="mt-1 truncate text-[11px] text-[var(--muted)]">
                          メモ: {t.memo}
                        </div>
                      )}
                    </div>
                    <ChevronRight size={16} className="text-[var(--muted)]" />
                  </Link>
                );
              })}
            </div>
          </Card>
        </div>

        {/* right column */}
        <div className="space-y-5">
          <Card>
            <CardTitle title="最新テイク" subtitle={formatDateTime(latest.recordedAt)} />
            <div className="flex flex-col items-center gap-4 p-5">
              <ScoreRing score={latest.overallScore} size={120} label="総合スコア" />
              {prev && (
                <div className="text-xs text-[var(--muted)]">
                  前回 {prev.overallScore.toFixed(1)} →{" "}
                  <span className="text-green-400">
                    {signed(
                      Math.round((latest.overallScore - prev.overallScore) * 10) / 10,
                    )}
                  </span>
                </div>
              )}
              <div className="w-full space-y-3 pt-2">
                {METRIC_KEYS.map((k) => (
                  <MetricBar
                    key={k}
                    label={METRIC_LABELS[k]}
                    value={latest.metrics[k]}
                    delta={
                      prev
                        ? Math.round((latest.metrics[k] - prev.metrics[k]) * 10) / 10
                        : undefined
                    }
                    hint={METRIC_DESCRIPTIONS[k]}
                  />
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="目標" />
            <div className="space-y-3 p-5 text-xs">
              {song.goalDate ? (
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3.5">
                  <Target size={16} className="mt-0.5 shrink-0 text-amber-300" />
                  <div>
                    <div className="text-sm font-semibold text-amber-200">
                      あと {daysUntil(song.goalDate)} 日
                    </div>
                    <div className="mt-0.5 text-[var(--muted)]">{song.goalDescription}</div>
                    <div className="mt-0.5 text-[var(--muted)]">{song.goalDate}</div>
                  </div>
                </div>
              ) : (
                <p className="text-[var(--muted)]">{song.goalDescription ?? "目標未設定"}</p>
              )}
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-[var(--muted)]">
                  <span>テンポ到達度</span>
                  <span className="tabular-nums">
                    ♩={song.currentTempo} / 目標 {song.targetTempo}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (song.currentTempo / song.targetTempo) * 100)}%`,
                      backgroundColor: song.accent,
                    }}
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle title="停滞している小節" subtitle="初回テイクから伸びていない箇所" />
            <div className="space-y-2 p-5">
              {stagnant.length === 0 ? (
                <p className="text-xs text-[var(--muted)]">
                  すべての小節が改善しています。素晴らしい。
                </p>
              ) : (
                stagnant.slice(0, 5).map((s) => (
                  <button
                    key={s.measure}
                    onClick={() => setSelected(s.measure)}
                    className="flex w-full items-center justify-between rounded-lg border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-left"
                  >
                    <span className="text-sm">{s.measure} 小節</span>
                    <span className="text-[11px] text-[var(--muted)]">
                      {signed(s.delta)} 点 / 現在 {s.score.toFixed(0)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function NavBtn({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
    >
      {icon} {label}
    </Link>
  );
}
