"use client";

import { useEffect, useState } from "react";
import type { SongDocStatus } from "@/lib/server/types";

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

// songId ごとに紐付けて保持する。songId が変わった／null になった直後は、まだ effect が
// 動いていない古い songId 分の progress が state に残っている可能性があるため、
// 「今の songId と一致する progress か」を戻り値の計算時に判定して切り替える。
// これにより、リセットのための setState をエフェクト本文に直接書かずに済む
// （react-hooks/set-state-in-effect: setState はコールバック内でのみ行う）。
interface StoredProgress extends SongScoreProgress {
  songId: string;
}

/**
 * 楽譜登録の進捗を購読する。songId が null の間は何もしない。
 * 参照譜の生成はワーカーが行うため、登録画面と楽譜差し替えの両方がこれで待つ
 * （待ち処理を2箇所に書かないための共有点）。
 */
export function useSongScoreProgress(songId: string | null): SongScoreProgress {
  const [stored, setStored] = useState<StoredProgress | null>(null);

  useEffect(() => {
    if (!songId) return;
    const source = new EventSource(`/api/songs/${songId}/events`);
    source.addEventListener("status", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as StatusEvent;
      setStored({
        songId,
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
    source.addEventListener("done", () => source.close());
    // ブラウザは接続が切れると自動再接続する。上のサーバー側は done で閉じるので、
    // ここで明示的に閉じないと終端後に再接続を繰り返す。
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [songId]);

  if (!songId || stored?.songId !== songId) return EMPTY_PROGRESS;
  return stored;
}
