"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { getTake, type ApiTakeDetail } from "@/lib/api/client";
import TakeEvaluationPanel from "@/components/TakeEvaluationPanel";

export default function RealTakeResultPage() {
  const params = useParams<{ takeId: string }>();
  const takeId = params.takeId;
  const [take, setTake] = useState<ApiTakeDetail | null>(null);
  const [error, setError] = useState("");

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

      <div className="mt-5">
        <Link href="/songs/new" className="text-xs text-violet-300 underline underline-offset-2">
          別の曲を登録する
        </Link>
      </div>
    </div>
  );
}
