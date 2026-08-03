import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, NotFoundError, readJson } from "@/lib/server/http";
import { assertResourceId, parseSchema, takePatchSchema } from "@/lib/server/validation";
import { getTake, updateTake } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    const take = await getTake(takeId, user.id);
    if (!take) throw new NotFoundError("take not found");
    return jsonResponse({
      id: take.id, songId: take.songId, label: take.label, recordedAt: take.recordedAt,
      durationSec: take.durationSec, requestedMeasureRange: take.requestedMeasureRange,
      playedMeasureRange: take.playedMeasureRange, requestedTempo: take.requestedTempo,
      inputKind: take.inputKind, status: take.status, progress: take.progress, failure: take.failure,
      overallScore: take.overallScore, metrics: take.metrics, metricsNAReason: take.metricsNAReason,
      measureScores: take.measureScores, issues: take.issues, aiReview: take.aiReview,
      analysis: take.analysis, memo: take.memo,
      links: { audio: `/api/takes/${take.id}/audio`, score: `/api/songs/${take.songId}/score-file` },
    }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    if (!(await getTake(takeId, user.id))) throw new NotFoundError("take not found");
    const patch = parseSchema(takePatchSchema, await readJson(request));
    const updated = await updateTake(takeId, patch, user.id);
    return jsonResponse({ id: updated.id, label: updated.label, memo: updated.memo }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
