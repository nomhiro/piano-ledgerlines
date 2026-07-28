import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { audioDir } from "@/lib/server/paths";
import { getTake, updateTake } from "@/lib/server/repository";
import { runAnalyzeWorkerAsync } from "@/lib/server/worker";

export const runtime = "nodejs";

// POST /api/takes/{takeId}/submit — 解析キューへ投入 (api.md 5.2 #16)
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  const { takeId } = await params;
  const take = await getTake(takeId);
  if (!take) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "take not found" } },
      { status: 404 }
    );
  }

  let hasAudio = false;
  try {
    const entries = await fs.readdir(audioDir(takeId));
    hasAudio = entries.some((name) => name.startsWith("original."));
  } catch {
    hasAudio = false;
  }
  if (!hasAudio) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "audio blob missing",
          details: { reason: "blob_missing" },
        },
      },
      { status: 400 }
    );
  }

  await updateTake(takeId, { status: "queued", progress: 0, failure: null });
  // 非同期実行(fire-and-forget)。ワーカーがtake.jsonのstatusを段階的に更新する。
  runAnalyzeWorkerAsync(takeId);

  // 3分の曲で約4.3分(m4-report.md)。ローカルCPU推論を前提にした概算値。
  const estimatedSeconds = Math.max(30, Math.round(take.durationSec * 1.5));

  return NextResponse.json(
    { takeId, status: "queued", estimatedSeconds, queuePosition: 1 },
    { status: 202 }
  );
}
