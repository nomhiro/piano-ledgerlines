import { getAuthenticatedUser } from "@/lib/server/auth";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { listSongTakeSummaries, listSongs } from "@/lib/server/repository";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; studentId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, studentId } = await params;
    await assertTeacherCanAccessStudent(classroomId, user.id, studentId, getRepository());
    const songs = await listSongs(studentId);
    return jsonResponse({
      songs,
      takeSummaries: await listSongTakeSummaries(songs.map((song) => song.id), studentId),
    }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
