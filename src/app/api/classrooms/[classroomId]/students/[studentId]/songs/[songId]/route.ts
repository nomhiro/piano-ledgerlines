import { getAuthenticatedUser } from "@/lib/server/auth";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { errorResponse, jsonResponse, NotFoundError } from "@/lib/server/http";
import { getRepository, getSong, listTakesBySong } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; studentId: string; songId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, studentId, songId } = await params;
    const repository = getRepository();
    await assertTeacherCanAccessStudent(classroomId, user.id, studentId, repository);
    const song = await getSong(songId, studentId);
    if (!song) throw new NotFoundError("song not found");
    return jsonResponse({ song, takes: await listTakesBySong(songId, studentId) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
