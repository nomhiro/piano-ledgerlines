"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { measureScoreKey, measureScoreMapFromKey, type MeasureScoreInput } from "@/components/score-overlay";
import { scoreColor } from "@/lib/format";

interface Overlay {
  measure: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number | null;
  /** このテイクに記録はあるが採点が保留された小節。 */
  withheld: boolean;
}

export default function ScoreView({
  scoreUrl,
  measureScores = [],
  showHeatmap = true,
  onSelectMeasure,
  selected,
  footnote,
}: {
  scoreUrl: string;
  measureScores?: readonly MeasureScoreInput[];
  showHeatmap?: boolean;
  onSelectMeasure?: (measure: number) => void;
  selected?: number | null;
  /** 楽譜の下に出す注記。渡されなければ何も出さない。 */
  footnote?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const scoreKey = measureScoreKey(measureScores);
  const scoreMap = useMemo(() => measureScoreMapFromKey(scoreKey), [scoreKey]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;

    (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (!host || cancelled) return;
        host.innerHTML = "";
        const osmd = new OpenSheetMusicDisplay(host, {
          autoResize: false,
          drawTitle: false,
          drawPartNames: false,
          drawComposer: false,
          drawingParameters: "compacttight",
        });
        const scoreResponse = await fetch(scoreUrl);
        if (!scoreResponse.ok) throw new Error(`score request failed (${scoreResponse.status})`);
        const scoreContentType = scoreResponse.headers.get("Content-Type") ?? "";
        await osmd.load(
          scoreContentType.includes("xml")
            ? await scoreResponse.text()
            : new Blob([new Uint8Array(await scoreResponse.arrayBuffer())], { type: scoreContentType }),
        );
        if (cancelled) return;
        osmd.zoom = 0.72;
        osmd.render();
        if (cancelled) return;

        const unit = 10 * osmd.zoom;
        const rects: Overlay[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[][] = (osmd as any).GraphicSheet?.MeasureList ?? [];

        list.forEach((staffMeasures) => {
          const present = (staffMeasures ?? []).filter(Boolean);
          if (present.length === 0) return;
          const first = present[0];
          const last = present[present.length - 1];
          const bb = first.PositionAndShape;
          const lb = last.PositionAndShape;
          const measureNo = first.MeasureNumber ?? first.parentSourceMeasure?.MeasureNumber;
          if (measureNo == null) return;
          const x = (bb.AbsolutePosition.x + bb.BorderLeft) * unit;
          const w = (bb.BorderRight - bb.BorderLeft) * unit;
          const top = (bb.AbsolutePosition.y + bb.BorderTop) * unit;
          const bottom = (lb.AbsolutePosition.y + lb.BorderBottom) * unit;
          const score = scoreMap.get(measureNo) ?? null;
          rects.push({
            measure: measureNo,
            x,
            y: top,
            w,
            h: Math.max(10, bottom - top),
            score,
            withheld: score === null && scoreMap.has(measureNo),
          });
        });

        setOverlays(rects);
        setStatus("ready");
      } catch (e) {
        console.error("OSMD render failed", e);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scoreUrl, scoreMap]);

  return (
    <div>
      <div className="relative overflow-x-auto rounded-lg bg-white p-3">
        <div ref={hostRef} className="osmd-host relative" />
        {showHeatmap && (
          <div className="pointer-events-none absolute inset-0 p-3">
            <div className="relative h-full w-full">
              {overlays.map((o) => (
                <div
                  key={o.measure}
                  onClick={onSelectMeasure ? () => onSelectMeasure(o.measure) : undefined}
                  className={`pointer-events-auto absolute rounded-sm transition-opacity ${
                    onSelectMeasure ? "cursor-pointer hover:opacity-70" : ""
                  } ${selected === o.measure ? "ring-2 ring-violet-600" : ""}`}
                  style={{
                    left: o.x,
                    top: o.y,
                    width: o.w,
                    height: o.h,
                    backgroundColor:
                      o.score === null ? "transparent" : `${scoreColor(o.score)}38`,
                    // 判定保留は色で点数を暗示できないため、斜線で「記録はあるが未採点」を
                    // 示す（TakeEvaluationPanel の数字グリッドの表現に合わせる）。
                    backgroundImage: o.withheld
                      ? "repeating-linear-gradient(135deg, transparent, transparent 3px, #94a3b8 3px, #94a3b8 4px)"
                      : undefined,
                    borderBottom:
                      o.score === null ? "none" : `3px solid ${scoreColor(o.score)}`,
                  }}
                  title={
                    o.score !== null
                      ? `${o.measure}小節：${o.score.toFixed(1)}点`
                      : o.withheld
                        ? `${o.measure}小節（判定保留）`
                        : `${o.measure}小節（このテイクの対象外）`
                  }
                />
              ))}
            </div>
          </div>
        )}
        {status === "loading" && (
          <div className="flex h-40 items-center justify-center text-sm text-slate-500">
            楽譜を描画しています…
          </div>
        )}
        {status === "error" && (
          <div className="flex h-40 items-center justify-center text-sm text-slate-500">
            楽譜の描画に失敗しました（MusicXMLの読み込みエラー）
          </div>
        )}
      </div>
      {footnote && showHeatmap && status === "ready" && (
        <p className="mt-2 text-[11px] text-[var(--muted)]">{footnote}</p>
      )}
    </div>
  );
}
