import fs from "node:fs/promises";
import path from "node:path";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { assertTeacherCanAccessStudent } from "@/lib/server/classroom-access";
import { errorResponse, NotFoundError } from "@/lib/server/http";
import { getRepository, getTake } from "@/lib/server/repository";
import { audioDir } from "@/lib/server/paths";
import { getBlobStore } from "@/lib/server/blob-storage";
import { getConfig } from "@/lib/server/config";

export const runtime = "nodejs";

const AUDIO_EXTENSIONS = [".webm", ".wav", ".wave", ".mp3", ".mp4", ".ogg"];

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
    let bytes: Buffer;
    let contentType = take.contentType ?? "audio/webm";
    if (getConfig().storageBackend === "azure") {
      let lastError: unknown;
      for (const extension of AUDIO_EXTENSIONS) {
        try {
          bytes = await getBlobStore().download(getConfig().audioContainer, `users/${studentId}/songs/${take.songId}/takes/${takeId}/original${extension}`);
          contentType = take.contentType ?? `audio/${extension.slice(1)}`;
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=300" } });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new NotFoundError("audio asset not found");
    }
    const entries = await fs.readdir(audioDir(takeId));
    const audioName = entries.find((entry) => entry.startsWith("original") && AUDIO_EXTENSIONS.includes(path.extname(entry).toLowerCase()));
    if (!audioName) throw new NotFoundError("audio asset not found");
    bytes = await fs.readFile(path.join(audioDir(takeId), audioName));
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return errorResponse(request, error);
  }
}
