"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { getTake, submitTake, type ApiTakeDetail } from "@/lib/api/client";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";
import TakeScoreCard from "@/components/TakeScoreCard";

export default function RealTakeResultPage() {
  const params = useParams<{ takeId: string }>();
  const takeId = params.takeId;
  const [take, setTake] = useState<ApiTakeDetail | null>(null);
  const [error, setError] = useState("");
  // 再解析リクエストの送信中フラグ。true の間はボタンを無効化し、
  // ダブルクリックで submit が2回飛ぶのを防ぐ（このコンポーネント内だけの
  // 一時状態なので、TakeEvaluationPanel 側には持たせない）。
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getTake(takeId);
        if (!cancelled) setTake(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [takeId]);

  const handleRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError("");
    try {
      await submitTake(takeId);
      // status: "queued" になったことを画面に反映する（古い evaluation を
      // 出し続けないよう、submit route 側で解析結果もリセットされている）。
      const data = await getTake(takeId);
      setTake(data);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [retrying, takeId]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!take) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
        <Loader2 size={16} className="animate-spin" /> 読み込み中…
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="分析結果（実データ）"
        description={`テイク ${take.id} ・ 曲 ${take.songId} ・ ステータス: ${take.status}`}
      />

      <TakeEvaluationPanel take={take} />

      <TakeScoreCard songId={take.songId} measureScores={take.measureScores} />

      {take.status === "failed" && (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {retrying && <Loader2 size={14} className="animate-spin" />}
            再解析する
          </button>
          {retryError && <p className="text-xs text-red-300">{retryError}</p>}
        </div>
      )}

      <div className="mt-5">
        <Link href="/songs/new" className="text-xs text-violet-300 underline underline-offset-2">
          別の曲を登録する
        </Link>
      </div>
    </div>
  );
}
