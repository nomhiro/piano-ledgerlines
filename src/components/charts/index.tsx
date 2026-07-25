"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const AXIS = { fill: "#8d97ad", fontSize: 11 };
const GRID = "#242c40";

const tooltipStyle = {
  backgroundColor: "#141824",
  border: "1px solid #2a3145",
  borderRadius: 8,
  fontSize: 12,
  color: "#e8ecf5",
};

export function MetricRadar({
  data,
}: {
  data: { metric: string; current: number; previous?: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={data} outerRadius="72%">
        <PolarGrid stroke={GRID} />
        <PolarAngleAxis dataKey="metric" tick={{ ...AXIS, fontSize: 10 }} />
        <PolarRadiusAxis domain={[0, 100]} tick={{ ...AXIS, fontSize: 9 }} stroke={GRID} />
        {data[0]?.previous !== undefined && (
          <Radar
            name="前回"
            dataKey="previous"
            stroke="#64748b"
            fill="#64748b"
            fillOpacity={0.18}
          />
        )}
        <Radar
          name="今回"
          dataKey="current"
          stroke="#a78bfa"
          fill="#a78bfa"
          fillOpacity={0.35}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: "#8d97ad" }} />
        <Tooltip contentStyle={tooltipStyle} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

export function ScoreTrend({
  data,
  height = 220,
}: {
  data: { label: string; score: number; tempo?: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} stroke={GRID} />
        <YAxis domain={[0, 100]} tick={AXIS} stroke={GRID} />
        <Tooltip contentStyle={tooltipStyle} />
        <Line
          type="monotone"
          dataKey="score"
          name="総合スコア"
          stroke="#a78bfa"
          strokeWidth={2.5}
          dot={{ r: 4, fill: "#a78bfa" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MultiMetricTrend({
  data,
  series,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} stroke={GRID} />
        <YAxis domain={[0, 100]} tick={AXIS} stroke={GRID} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TempoCurveChart({
  data,
}: {
  data: { measure: number; bpm: number; target: number }[];
}) {
  const target = data[0]?.target ?? 120;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="measure" tick={AXIS} stroke={GRID} />
        <YAxis domain={["dataMin - 8", "dataMax + 8"]} tick={AXIS} stroke={GRID} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(v) => `${v} 小節`}
          formatter={(v) => [`${v} BPM`, ""]}
        />
        <ReferenceLine
          y={target}
          stroke="#64748b"
          strokeDasharray="4 4"
          label={{ value: `目標 ${target}`, fill: "#8d97ad", fontSize: 10, position: "right" }}
        />
        <Line
          type="monotone"
          dataKey="bpm"
          name="実測テンポ"
          stroke="#38bdf8"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DynamicsChart({
  data,
}: {
  data: { measure: number; actual: number; target: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="dynActual" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f472b6" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#f472b6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="measure" tick={AXIS} stroke={GRID} />
        <YAxis domain={[0, 100]} tick={AXIS} stroke={GRID} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `${v} 小節`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Area
          type="monotone"
          dataKey="target"
          name="楽譜の指示（理想）"
          stroke="#64748b"
          strokeDasharray="4 4"
          fill="none"
        />
        <Area
          type="monotone"
          dataKey="actual"
          name="実測音量"
          stroke="#f472b6"
          strokeWidth={2}
          fill="url(#dynActual)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function PracticeBar({
  data,
}: {
  data: { date: string; minutes: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={{ ...AXIS, fontSize: 10 }} stroke={GRID} />
        <YAxis tick={AXIS} stroke={GRID} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} 分`, "練習時間"]} />
        <Bar dataKey="minutes" fill="#a78bfa" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function MeasureDeltaBar({
  data,
}: {
  data: { measure: number; delta: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="measure" tick={AXIS} stroke={GRID} />
        <YAxis tick={AXIS} stroke={GRID} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(v) => `${v} 小節`}
          formatter={(v) => [`${Number(v) > 0 ? "+" : ""}${v} 点`, "初回からの伸び"]}
        />
        <ReferenceLine y={0} stroke="#64748b" />
        <Bar dataKey="delta" radius={[3, 3, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.measure} fill={d.delta >= 3 ? "#22c55e" : d.delta >= 0 ? "#eab308" : "#ef4444"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
