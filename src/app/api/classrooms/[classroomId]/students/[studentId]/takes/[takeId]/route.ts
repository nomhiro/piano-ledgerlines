import { getAuthenticatedUser } from "@/lib/server/auth";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { errorResponse, jsonResponse, NotFoundError } from "@/lib/server/http";
import { getRepository, getTake } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; studentId: string; takeId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, studentId, takeId } = await params;
    const repository = getRepository();
    await assertTeacherCanAccessStudent(classroomId, user.id, studentId, repository);
    const take = await getTake(takeId, studentId);
    if (!take) throw new NotFoundError("take not found");
    return jsonResponse({
      id: take.id,
      userId: take.userId,
      songId: take.songId,
      label: take.label,
      recordedAt: take.recordedAt,
      durationSec: take.durationSec,
      inputKind: take.inputKind,
      status: take.status,
      progress: take.progress,
      failure: take.failure,
      overallScore: take.overallScore,
      metrics: take.metrics,
      metricConfidence: take.metricConfidence,
      metricEvaluations: take.metricEvaluations,
      evaluation: take.evaluation,
      measureScores: take.measureScores,
      issues: take.issues,
      analysis: take.analysis,
      memo: take.memo,
      links: {
        audio: `/api/classrooms/${classroomId}/students/${studentId}/takes/${takeId}/audio`,
        score: `/api/classrooms/${classroomId}/students/${studentId}/songs/${take.songId}/score`,
      },
    }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
