"use client";

import { useEffect, useState } from "react";
import type { SongDocStatus } from "@/lib/server/types";
import {
  scoreProgressStalledMessage,
  scoreProgressStreamErrorMessage,
  type ScoreProgressStreamError,
} from "@/lib/score-progress";

export interface ScoreInfo {
  measureCount: number;
  timeSignature: string;
  keySignature: string;
  detectedTempo: number;
  warnings: { code: string; message: string }[];
}

export interface SongScoreProgress {
  status: SongDocStatus | null;
  info: ScoreInfo | null;
  failureMessage: string | null;
}

interface StatusEvent {
  status: SongDocStatus;
  measureCount: number | null;
  keySignature: string | null;
  timeSignature: string | null;
  detectedTempo: number | null;
  warnings: { code: string; message: string }[] | null;
  failureMessage: string | null;
}

const EMPTY_PROGRESS: SongScoreProgress = { status: null, info: null, failureMessage: null };

/** SSE の名前付き `error` イベント（route.ts の NOT_FOUND / INTERNAL）だけが data を持つ。
 * ブラウザ自身の接続断（初回接続失敗・一時的な切断）は data の無い素の Event になる。 */
function parseServerErrorEvent(event: Event): ScoreProgressStreamError | null {
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as ScoreProgressStreamError;
  } catch {
    return null;
  }
}

/**
 * 楽譜登録の進捗を購読する。songId が null の間は何もしない。
 * 参照譜の生成はワーカーが行うため、登録画面と楽譜差し替えの両方がこれで待つ
 * （待ち処理を2箇所に書かないための共有点）。
 */
export function useSongScoreProgress(songId: string | null): SongScoreProgress {
  const [progress, setProgress] = useState<SongScoreProgress | null>(null);

  useEffect(() => {
    if (!songId) return;
    const source = new EventSource(`/api/songs/${songId}/events`);
    source.addEventListener("status", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as StatusEvent;
      setProgress({
        status: data.status,
        info: data.status === "ready"
          ? {
              measureCount: data.measureCount ?? 0,
              timeSignature: data.timeSignature ?? "未検出",
              keySignature: data.keySignature ?? "未検出",
              detectedTempo: data.detectedTempo ?? 0,
              warnings: data.warnings ?? [],
            }
          : null,
        failureMessage: data.failureMessage,
      });
    });
    source.addEventListener("done", (event) => {
      source.close();
      const data = JSON.parse((event as MessageEvent<string>).data) as { status: SongDocStatus };
      // ready / 明示的な失敗（omr_failed・awaiting_score）は直前の status イベントで
      // 既に正しく反映されている。それ以外の状態で done になった場合だけ、結果が出ない
      // まま終わったことをここで伝える（ワーカー停止による MAX_DURATION_MS 打ち切りなど）。
      const stalledMessage = scoreProgressStalledMessage(data.status);
      if (stalledMessage) {
        setProgress({ status: data.status, info: null, failureMessage: stalledMessage });
      }
    });
    source.addEventListener("error", (event) => {
      const serverError = parseServerErrorEvent(event);
      // サーバーが名前付き error イベントで打ち切った場合は、サーバー側は既にストリームを
      // 閉じている。ブラウザ側の接続断（初回接続失敗・一時的な切断）はここでは閉じず、
      // last-event-id による自動再接続に回復を任せる。
      if (serverError) source.close();
      setProgress({ status: null, info: null, failureMessage: scoreProgressStreamErrorMessage(serverError) });
    });
    return () => {
      source.close();
      // songId が変わる、または一度 null を経由して同じ songId に戻ったとき、次の
      // サブスクリプションが前回の progress を再表示しないようにする。
      setProgress(null);
    };
  }, [songId]);

  if (!songId || !progress) return EMPTY_PROGRESS;
  return progress;
}
