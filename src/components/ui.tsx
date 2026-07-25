import type { ReactNode } from "react";
import { scoreColor } from "@/lib/format";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-3.5">
      <div>
        <h2 className="text-[15px] font-semibold tracking-wide">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  );
}

export function Badge({
  children,
  color = "#64748b",
  subtle = true,
}: {
  children: ReactNode;
  color?: string;
  subtle?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={
        subtle
          ? { backgroundColor: `${color}22`, color, border: `1px solid ${color}44` }
          : { backgroundColor: color, color: "#0b0d14" }
      }
    >
      {children}
    </span>
  );
}

export function ScoreRing({
  score,
  size = 96,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const stroke = size / 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = scoreColor(score);
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2a3145" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="font-semibold tabular-nums" style={{ fontSize: size / 3.4, color }}>
          {Math.round(score)}
        </span>
        {label && <span className="text-[10px] text-[var(--muted)]">{label}</span>}
      </div>
    </div>
  );
}

export function MetricBar({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: number;
  delta?: number;
  hint?: string;
}) {
  const color = scoreColor(value);
  return (
    <div title={hint}>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-[var(--muted)]">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-semibold tabular-nums" style={{ color }}>
            {value.toFixed(1)}
          </span>
          {delta !== undefined && (
            <span
              className={`tabular-nums text-[10px] ${
                delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-[var(--muted)]"
              }`}
            >
              {delta > 0 ? "▲" : delta < 0 ? "▼" : "―"}
              {Math.abs(delta).toFixed(1)}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="text-[11px] text-[var(--muted)]">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit && <span className="text-xs text-[var(--muted)]">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[11px] text-[var(--muted)]">{hint}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
        )}
      </div>
      {right}
    </div>
  );
}

export function MockNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[#3b4560] bg-[#141824] px-4 py-3 text-xs text-[var(--muted)]">
      {children}
    </div>
  );
}
