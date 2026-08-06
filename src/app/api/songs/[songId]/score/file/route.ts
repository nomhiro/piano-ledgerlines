import fs from "node:fs/promises";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong } from "@/lib/server/repository";
import { scoreFilePath } from "@/lib/server/paths";
import { getBlobStore } from "@/lib/server/blob-storage";
import { getConfig } from "@/lib/server/config";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<"score" | "midi", string> = {
  score: "application/vnd.recordare.musicxml+xml",
  midi: "audio/midi",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    const song = await getSong(songId, user.id);
    if (!song) throw new NotFoundError("song not found");
    const hasPreview = song.status === "ready"
      || (song.status === "reviewing_score" && song.scoreSource === "pdf");
    if (!hasPreview || !song.scoreFileName) {
      throw new ValidationError("score preview is not available");
    }

    const format = new URL(request.url).searchParams.get("format") ?? "score";
    if (format !== "score" && format !== "midi") throw new ValidationError("format must be score or midi");
    const fileName = format === "midi"
      ? song.previewMidiFileName
      : song.previewScoreFileName;
    if (!fileName) throw new NotFoundError("score preview asset not found");

    let bytes: Buffer;
    if (getConfig().storageBackend === "azure") {
      try {
        bytes = await getBlobStore().download(
          getConfig().scoresContainer,
          `users/${user.id}/songs/${songId}/scores/${fileName}`,
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: number }).statusCode === 404) {
          throw new NotFoundError("score preview asset not found");
        }
        throw error;
      }
    } else {
      try {
        bytes = await fs.readFile(scoreFilePath(songId, fileName));
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
          throw new NotFoundError("score preview asset not found");
        }
        throw error;
      }
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
