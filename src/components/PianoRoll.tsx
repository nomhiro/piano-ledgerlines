"use client";

import { useMemo, useState } from "react";
import type { RollNote, NoteStatus } from "@/lib/mock/types";

const STATUS_STYLE: Record<NoteStatus, { fill: string; label: string }> = {
  correct: { fill: "#38bdf8", label: "正しく弾けた音" },
  missed: { fill: "#ef4444", label: "抜けた音（弾かれていない）" },
  extra: { fill: "#f59e0b", label: "余分な音（譜面にない）" },
  late: { fill: "#a855f7", label: "遅れた音" },
  early: { fill: "#22d3ee", label: "早すぎた音" },
};

const BEAT_W = 26;
const NOTE_H = 6;

export default function PianoRoll({
  notes,
  beatsPerMeasure = 3,
}: {
  notes: RollNote[];
  beatsPerMeasure?: number;
}) {
  const [filter, setFilter] = useState<NoteStatus | "all">("all");

  const { minMidi, maxMidi, totalBeats, firstMeasure } = useMemo(() => {
    const midis = notes.map((n) => n.midi);
    const beats = notes.map((n) => n.startBeat + n.durationBeats);
    return {
      minMidi: Math.min(...midis) - 2,
      maxMidi: Math.max(...midis) + 2,
      totalBeats: Math.ceil(Math.max(...beats)),
      firstMeasure: Math.min(...notes.map((n) => n.measure)),
    };
  }, [notes]);

  const rows = maxMidi - minMidi;
  const height = rows * NOTE_H;
  const width = totalBeats * BEAT_W;
  const y = (midi: number) => (maxMidi - midi) * NOTE_H;

  const measureCount = Math.ceil(totalBeats / beatsPerMeasure);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} color="#8d97ad">
          すべて
        </FilterChip>
        {(Object.keys(STATUS_STYLE) as NoteStatus[]).map((s) => (
          <FilterChip
            key={s}
            active={filter === s}
            onClick={() => setFilter(filter === s ? "all" : s)}
            color={STATUS_STYLE[s].fill}
          >
            {STATUS_STYLE[s].label}
            <span className="ml-1 tabular-nums opacity-70">
              {notes.filter((n) => n.status === s).length}
            </span>
          </FilterChip>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[#0e1220] p-3">
        <svg width={width + 40} height={height + 26}>
          {/* 小節線 */}
          {Array.from({ length: measureCount + 1 }).map((_, i) => (
            <g key={i}>
              <line
                x1={40 + i * beatsPerMeasure * BEAT_W}
                x2={40 + i * beatsPerMeasure * BEAT_W}
                y1={0}
                y2={height}
                stroke="#2a3145"
              />
              {i < measureCount && (
                <text
                  x={44 + i * beatsPerMeasure * BEAT_W}
                  y={height + 16}
                  fill="#8d97ad"
                  fontSize={10}
                >
                  {firstMeasure + i}
                </text>
              )}
            </g>
          ))}
          {/* 拍線 */}
          {Array.from({ length: totalBeats }).map((_, i) =>
            i % beatsPerMeasure === 0 ? null : (
              <line
                key={`b${i}`}
                x1={40 + i * BEAT_W}
                x2={40 + i * BEAT_W}
                y1={0}
                y2={height}
                stroke="#1b2030"
              />
            ),
          )}
          {/* 中央C の目安線 */}
          {[48, 60, 72, 84].map((m) =>
            m > minMidi && m < maxMidi ? (
              <g key={m}>
                <line x1={40} x2={width + 40} y1={y(m)} y2={y(m)} stroke="#2a3145" strokeDasharray="2 4" />
                <text x={4} y={y(m) + 3} fill="#8d97ad" fontSize={9}>
                  C{Math.floor(m / 12) - 1}
                </text>
              </g>
            ) : null,
          )}
          {/* 音符 */}
          {notes.map((n) => {
            const dim = filter !== "all" && n.status !== filter;
            const style = STATUS_STYLE[n.status];
            const w = Math.max(6, n.durationBeats * BEAT_W - 3);
            const isMissed = n.status === "missed";
            return (
              <rect
                key={n.id}
                x={40 + n.startBeat * BEAT_W}
                y={y(n.midi)}
                width={w}
                height={NOTE_H - 1.5}
                rx={2}
                fill={isMissed ? "none" : style.fill}
                stroke={isMissed ? style.fill : "none"}
                strokeDasharray={isMissed ? "3 2" : undefined}
                opacity={dim ? 0.12 : n.hand === "L" ? 0.62 : 1}
              >
                <title>
                  {`${n.measure}小節 / ${n.hand === "R" ? "右手" : "左手"} / MIDI ${n.midi} / ${style.label} / velocity ${n.velocity}`}
                </title>
              </rect>
            );
          })}
        </svg>
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        録音音声をAIで採譜した結果と、楽譜データをアライメントして重ね合わせています。濃い色＝右手 /
        薄い色＝左手、点線の枠＝弾かれなかった音。
      </p>
    </div>
  );
}

function FilterChip({
  children,
  active,
  onClick,
  color,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-opacity"
      style={{
        backgroundColor: active ? `${color}30` : "transparent",
        border: `1px solid ${active ? color : "#2a3145"}`,
        color: active ? color : "#8d97ad",
      }}
    >
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
      {children}
    </button>
  );
}
