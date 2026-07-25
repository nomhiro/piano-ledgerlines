"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MeasureScore } from "@/lib/mock/types";
import { scoreColor } from "@/lib/format";

interface Overlay {
  measure: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number | null;
}

export default function ScoreView({
  scoreUrl,
  measureScores = [],
  showHeatmap = true,
  onSelectMeasure,
  selected,
}: {
  scoreUrl: string;
  measureScores?: MeasureScore[];
  showHeatmap?: boolean;
  onSelectMeasure?: (measure: number) => void;
  selected?: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const scoreKey = measureScores.map((m) => `${m.measure}:${m.score}`).join(",");
  const scoreMap = useMemo(
    () => new Map(scoreKey ? scoreKey.split(",").map((p) => {
      const [m, s] = p.split(":");
      return [Number(m), Number(s)] as [number, number];
    }) : []),
    [scoreKey],
  );

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
        await osmd.load(scoreUrl);
        if (cancelled) return;
        osmd.zoom = 0.72;
        osmd.render();
        if (cancelled) return;

        const unit = 10 * osmd.zoom;
        const rects: Overlay[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[][] = (osmd as any).GraphicSheet?.MeasureList ?? [];
        const scoreMapLocal = scoreMap;

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
          rects.push({
            measure: measureNo,
            x,
            y: top,
            w,
            h: Math.max(10, bottom - top),
            score: scoreMapLocal.has(measureNo) ? scoreMapLocal.get(measureNo)! : null,
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
                  onClick={() => onSelectMeasure?.(o.measure)}
                  className={`pointer-events-auto absolute cursor-pointer rounded-sm transition-opacity hover:opacity-70 ${
                    selected === o.measure ? "ring-2 ring-violet-600" : ""
                  }`}
                  style={{
                    left: o.x,
                    top: o.y,
                    width: o.w,
                    height: o.h,
                    backgroundColor:
                      o.score === null ? "transparent" : `${scoreColor(o.score)}38`,
                    borderBottom:
                      o.score === null ? "none" : `3px solid ${scoreColor(o.score)}`,
                  }}
                  title={
                    o.score === null
                      ? `${o.measure}小節（このテイクの対象外）`
                      : `${o.measure}小節：${o.score.toFixed(1)}点`
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
      {showHeatmap && status === "ready" && (
        <p className="mt-2 text-[11px] text-[var(--muted)]">
          ※ デモ用サンプル楽譜（16小節）に、分析結果の小節スコアを色で重ねています。本実装ではアップロードされたMusicXMLをそのまま表示します。
        </p>
      )}
    </div>
  );
}
