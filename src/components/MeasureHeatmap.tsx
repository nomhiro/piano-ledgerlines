"use client";

import { useState } from "react";
import type { MeasureScore } from "@/lib/mock/types";
import { METRIC_LABELS, METRIC_KEYS } from "@/lib/mock/types";
import { scoreColor } from "@/lib/format";

export default function MeasureHeatmap({
  measures,
  compare,
  mode = "score",
  onSelect,
  selected,
}: {
  measures: MeasureScore[];
  /** 比較対象（初回テイクなど）。mode="delta" のときに使用 */
  compare?: MeasureScore[];
  mode?: "score" | "delta";
  onSelect?: (measure: number) => void;
  selected?: number | null;
}) {
  const [hover, setHover] = useState<MeasureScore | null>(null);
  const compareMap = new Map((compare ?? []).map((m) => [m.measure, m.score]));

  const deltaColor = (d: number) =>
    d >= 12 ? "#22c55e" : d >= 5 ? "#84cc16" : d >= 1 ? "#eab308" : d >= -3 ? "#f97316" : "#ef4444";

  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {measures.map((m) => {
          const delta = compareMap.has(m.measure)
            ? Math.round((m.score - compareMap.get(m.measure)!) * 10) / 10
            : null;
          const color =
            mode === "delta" && delta !== null ? deltaColor(delta) : scoreColor(m.score);
          const isSelected = selected === m.measure;
          return (
            <button
              key={m.measure}
              onMouseEnter={() => setHover(m)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(m.measure)}
              className={`relative flex h-9 w-9 flex-col items-center justify-center rounded text-[10px] font-medium transition-transform hover:scale-110 ${
                isSelected ? "ring-2 ring-white" : ""
              }`}
              style={{ backgroundColor: `${color}33`, border: `1px solid ${color}` }}
              title={`${m.measure}小節`}
            >
              <span className="text-[9px] text-[var(--muted)]">{m.measure}</span>
              <span className="tabular-nums" style={{ color }}>
                {mode === "delta" && delta !== null
                  ? `${delta > 0 ? "+" : ""}${Math.round(delta)}`
                  : Math.round(m.score)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[10px] text-[var(--muted)]">
        {mode === "score" ? (
          <>
            <LegendDot color="#ef4444" label="〜40 要集中" />
            <LegendDot color="#f97316" label="40〜55" />
            <LegendDot color="#eab308" label="55〜70" />
            <LegendDot color="#84cc16" label="70〜85" />
            <LegendDot color="#22c55e" label="85〜 良好" />
          </>
        ) : (
          <>
            <LegendDot color="#ef4444" label="悪化" />
            <LegendDot color="#f97316" label="停滞" />
            <LegendDot color="#eab308" label="微増" />
            <LegendDot color="#84cc16" label="+5〜" />
            <LegendDot color="#22c55e" label="+12〜 大きく改善" />
          </>
        )}
      </div>

      <div className="mt-3 min-h-[74px] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-xs">
        {hover ? (
          <div>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-semibold">{hover.measure} 小節</span>
              <span className="tabular-nums" style={{ color: scoreColor(hover.score) }}>
                {hover.score.toFixed(1)} 点
              </span>
              {compareMap.has(hover.measure) && (
                <span className="text-[var(--muted)]">
                  初回 {compareMap.get(hover.measure)!.toFixed(1)} →{" "}
                  {hover.score.toFixed(1)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              {METRIC_KEYS.map((k) => (
                <div key={k} className="flex items-center justify-between gap-2">
                  <span className="text-[var(--muted)]">{METRIC_LABELS[k]}</span>
                  <span
                    className="tabular-nums"
                    style={{ color: scoreColor(hover.metrics[k]) }}
                  >
                    {hover.metrics[k].toFixed(0)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <span className="text-[var(--muted)]">
            小節にカーソルを合わせると、その小節の6指標の内訳が表示されます。
          </span>
        )}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: `${color}55`, border: `1px solid ${color}` }}
      />
      {label}
    </span>
  );
}
