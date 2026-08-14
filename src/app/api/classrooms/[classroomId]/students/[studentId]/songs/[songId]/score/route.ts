import fs from "node:fs/promises";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { errorResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { getRepository, getSong } from "@/lib/server/repository";
import { scoreFilePath } from "@/lib/server/paths";
import { getBlobStore } from "@/lib/server/blob-storage";
import { getConfig } from "@/lib/server/config";

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
    const format = new URL(request.url).searchParams.get("format") ?? "score";
    if (format !== "score" && format !== "midi") throw new ValidationError("format must be score or midi");
    const fileName = format === "midi" ? song.previewMidiFileName : song.previewScoreFileName;
    if (!fileName) throw new NotFoundError("score preview asset not found");
    let bytes: Buffer;
    if (getConfig().storageBackend === "azure") {
      bytes = await getBlobStore().download(getConfig().scoresContainer, `users/${studentId}/songs/${songId}/scores/${fileName}`);
    } else {
      bytes = await fs.readFile(scoreFilePath(songId, fileName));
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": format === "midi" ? "audio/midi" : "application/vnd.recordare.musicxml+xml",
        "Cache-Control": "private, no-store",
        "Pragma": "no-cache",
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
