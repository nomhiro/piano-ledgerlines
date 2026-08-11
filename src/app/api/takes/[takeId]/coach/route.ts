import { getAuthenticatedUser } from "@/lib/server/auth";
import { getCoach } from "@/lib/server/ai-coach";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong, getTake, updateTake } from "@/lib/server/repository";
import { getTelemetry } from "@/lib/server/observability";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  const correlationId = request.headers.get("x-request-id") ?? undefined;
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    const take = await getTake(takeId, user.id);
    if (!take) throw new NotFoundError("take not found");
    if (take.status !== "completed") throw new ValidationError("take scores are not ready");
    const scoredMetrics = Object.fromEntries(
      Object.entries(take.metrics ?? {}).map(([key, value]) => [
        key,
        take.metricEvaluations?.[key as keyof typeof take.metricEvaluations]?.status === "scored"
          ? value
          : null,
      ])
    ) as typeof take.metrics;
    if (!Object.values(scoredMetrics ?? {}).some((value) => value !== null)) {
      throw new ValidationError("analysis has no calibrated metrics for coaching");
    }
    const scoredIssues = take.issues.filter(
      (issue) => take.metricEvaluations?.[issue.metric]?.status === "scored"
    );
    const song = await getSong(take.songId, user.id);
    if (!song) throw new NotFoundError("song not found");

    const result = await getCoach().generate({
      song: {
        title: song.title,
        composer: song.composer,
        keySignature: song.keySignature,
        timeSignature: song.timeSignature,
        targetTempo: song.targetTempo,
      },
      take: {
        label: take.label,
        recordedAt: take.recordedAt,
        requestedMeasureRange: take.requestedMeasureRange,
        playedMeasureRange: take.playedMeasureRange,
        overallScore: take.overallScore,
        metrics: scoredMetrics,
        metricEvaluations: take.metricEvaluations,
        metricsNAReason: take.metricsNAReason,
      },
      issues: scoredIssues,
      history: [],
    }, correlationId);

    let persisted = true;
    try {
      await updateTake(take.id, { aiReview: result }, user.id);
    } catch {
      // A coach outage or persistence race must never hide already-computed scores.
      persisted = false;
      getTelemetry().record({ name: "foundry.coach.persistence_failed", correlationId, takeId });
    }
    getTelemetry().record({
      name: "foundry.coach.completed",
      correlationId,
      takeId,
      stage: "review",
      attributes: { source: result.metadata.source, persisted },
    });
    return jsonResponse({ takeId, review: result.review, metadata: result.metadata, persisted }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
