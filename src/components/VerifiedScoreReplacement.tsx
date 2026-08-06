"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadScore } from "@/lib/api/client";

export default function VerifiedScoreReplacement({ songId }: { songId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function replaceScore(file: File) {
    setStatus("解析中…");
    setError("");
    try {
      const result = await uploadScore(songId, file);
      if (result.status !== "ready") {
        throw new Error("楽譜を解析できませんでした。");
      }
      setStatus("差し替えが完了しました。");
      router.refresh();
    } catch (cause) {
      setStatus("");
      setError(cause instanceof Error ? cause.message : String(cause));
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
