"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadScore } from "@/lib/api/client";
import { useSongScoreProgress } from "@/lib/hooks/useSongScoreProgress";

type ReplaceState = "idle" | "uploading" | "watching";

export default function VerifiedScoreReplacement({ songId }: { songId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [state, setState] = useState<ReplaceState>("idle");
  const [uploadError, setUploadError] = useState("");
  const progress = useSongScoreProgress(state === "watching" ? songId : null);

  // watching 中は SSE の結果をそのまま画面の状態として使う（別の state にコピーしない）。
  const isDone = state === "watching" && progress.status === "ready";
  const failureMessage = state === "watching" ? progress.failureMessage : null;
  const status =
    state === "uploading" || (state === "watching" && !isDone && !failureMessage)
      ? "解析中…"
      : isDone
        ? "差し替えが完了しました。"
        : "";
  const error = failureMessage ?? uploadError;

  // router.refresh() は setState ではないため、完了時に一度だけ呼ぶ副作用として
  // ここに残す（表示状態自体は上の isDone / failureMessage の導出に任せる）。
  useEffect(() => {
    if (isDone) router.refresh();
  }, [isDone, router]);

  async function replaceScore(file: File) {
    setState("uploading");
    setUploadError("");
    try {
      const result = await uploadScore(songId, file);
      if (result.status !== "parsing_score") {
        throw new Error("楽譜のアップロードを受け付けられませんでした。");
      }
      setState("watching");
    } catch (cause) {
      setState("idle");
      setUploadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" aria-labelledby="verified-score-title">
      <h2 id="verified-score-title" className="font-semibold text-amber-100">分析には正確なデジタル楽譜が必要です</h2>
      <p className="mt-2 text-sm text-amber-50/90">
        PDFから自動変換した楽譜はプレビュー専用です。録音の照合・採点には、出版社や作譜ソフトから取得したMusicXML、MXL、またはMIDIを登録してください。
      </p>
      <input
        ref={inputRef}
        id={`verified-score-${songId}`}
        type="file"
        accept=".musicxml,.xml,.mxl,.mid,.midi"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void replaceScore(file);
        }}
      />
      <label
        htmlFor={`verified-score-${songId}`}
        className="mt-3 inline-flex cursor-pointer rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500"
      >
        正確な楽譜データに差し替える
      </label>
      {status && <p role="status" className="mt-2 text-sm text-amber-100">{status}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-200">{error}</p>}
    </section>
  );
}
