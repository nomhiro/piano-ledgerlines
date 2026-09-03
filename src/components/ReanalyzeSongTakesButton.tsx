"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { submitTake } from "@/lib/api/client";

export default function ReanalyzeSongTakesButton({ takeIds }: { takeIds: string[] }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");

  if (takeIds.length === 0) return null;

  async function reanalyze() {
    if (running) return;
    setRunning(true);
    setMessage("");

    let queued = 0;
    let failed = 0;
    for (const takeId of takeIds) {
      try {
        await submitTake(takeId);
        queued += 1;
      } catch {
        failed += 1;
      }
    }

    setMessage(
      failed === 0
        ? `${queued}件の再採点を開始しました。`
        : `${queued}件の再採点を開始しました。${failed}件は開始できませんでした。テイク詳細をご確認ください。`,
    );
    setRunning(false);
    router.refresh();
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={reanalyze}
        disabled={running}
        aria-busy={running}
        className="inline-flex items-center gap-2 rounded-lg border border-violet-400/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {running ? "再採点を開始中..." : "過去の演奏を再採点"}
      </button>
      <p role="status" aria-live="polite" className="text-xs text-[var(--muted)]">
        {message}
      </p>
    </div>
  );
}
