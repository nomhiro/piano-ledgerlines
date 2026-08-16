import { randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { getBlobStore } from "@/lib/server/blob-storage";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong, updateSong } from "@/lib/server/repository";
import { getScoreQueue } from "@/lib/server/queue";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ songId: string }> }) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    const song = await getSong(songId, user.id);
    if (!song) throw new NotFoundError("song not found");
    if (getConfig().storageBackend !== "azure") {
      throw new ValidationError("score completion is available for SAS uploads only");
    }
    const prefix = `users/${user.id}/songs/${songId}/scores/score`;
    let found = false;
    for (const ext of [".musicxml", ".xml", ".mxl", ".mid", ".midi"]) {
      if (await getBlobStore().exists(getConfig().scoresContainer, `${prefix}${ext}`)) {
        found = true;
        break;
      }
    }
    if (!found) throw new ValidationError("score blob missing");
    await updateSong(songId, { status: "parsing_score", lastScoreError: undefined }, user.id);
    await getScoreQueue().enqueue({
      schemaVersion: 1,
      jobId: randomUUID(),
      songId,
      userId: user.id,
      attempt: 1,
      correlationId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    return jsonResponse({ songId, status: "parsing_score", uploadComplete: true }, request, { status: 202 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
