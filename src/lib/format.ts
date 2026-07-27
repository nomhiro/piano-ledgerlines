import type { Severity } from "./mock/types";

/** スコア(0-100)を色に変換 */
export function scoreColor(score: number): string {
  if (score >= 85) return "#22c55e";
  if (score >= 70) return "#84cc16";
  if (score >= 55) return "#eab308";
  if (score >= 40) return "#f97316";
  return "#ef4444";
}

export function scoreTextClass(score: number): string {
  if (score >= 85) return "text-green-400";
  if (score >= 70) return "text-lime-400";
  if (score >= 55) return "text-yellow-400";
  if (score >= 40) return "text-orange-400";
  return "text-red-400";
}

export const severityColor: Record<Severity, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#64748b",
};

export const severityLabel: Record<Severity, string> = {
  high: "要対応",
  medium: "注意",
  low: "軽微",
};

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function daysUntil(dateStr: string, from = "2026-07-25"): number {
  const a = new Date(dateStr).getTime();
  const b = new Date(from).getTime();
  return Math.round((a - b) / 86400000);
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
