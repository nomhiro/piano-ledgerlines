import { NextResponse } from "next/server";
import { getTake, updateTake } from "@/lib/server/repository";

export const runtime = "nodejs";

// GET /api/takes/{takeId} — テイク詳細 (api.md 5.4 #15)
export async function GET(
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

  return NextResponse.json({
    id: take.id,
    songId: take.songId,
    label: take.label,
    recordedAt: take.recordedAt,
    durationSec: take.durationSec,
    requestedMeasureRange: take.requestedMeasureRange,
    playedMeasureRange: take.playedMeasureRange,
    requestedTempo: take.requestedTempo,
    inputKind: take.inputKind,
    status: take.status,
    progress: take.progress,
    failure: take.failure,

    overallScore: take.overallScore,
    metrics: take.metrics,
    metricsNAReason: take.metricsNAReason,
    measureScores: take.measureScores,
    issues: take.issues,

    aiReview: take.aiReview,
    analysis: take.analysis,

    memo: take.memo,
    links: {
      audio: `/api/takes/${take.id}/audio`,
      score: `/api/songs/${take.songId}/score-file`,
    },
  });
}

// PATCH /api/takes/{takeId} — ラベル・メモ更新 (api.md #18)
export async function PATCH(
  request: Request,
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

  const body = await request.json();
  const patch: { label?: string; memo?: string } = {};
  if (typeof body.label === "string") patch.label = body.label;
  if (typeof body.memo === "string") patch.memo = body.memo;

  const updated = await updateTake(takeId, patch);
  return NextResponse.json({ id: updated.id, label: updated.label, memo: updated.memo });
}
