import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getConfig } from "@/lib/server/config";
import { audioDir } from "@/lib/server/paths";
import { getTake, updateTake } from "@/lib/server/repository";
import { getBlobStore } from "@/lib/server/blob-storage";
import { getAnalysisQueue } from "@/lib/server/queue";

export const runtime = "nodejs";

async function hasAudio(userId: string, takeId: string, songId: string): Promise<boolean> {
  const config = getConfig();
  if (config.storageBackend === "azure") {
    const prefix = `users/${userId}/songs/${songId}/takes/${takeId}/original`;
    // Blob names are known from the validated upload extension; check supported forms.
    for (const ext of [".webm", ".wav", ".mp3", ".mp4", ".ogg"]) {
      if (await getBlobStore().exists(config.audioContainer, `${prefix}${ext}`)) return true;
    }
    return false;
  }
  try {
    const entries = await fs.readdir(audioDir(takeId));
    return entries.some((name) => name.startsWith("original."));
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    const take = await getTake(takeId, user.id);
    if (!take) throw new NotFoundError("take not found");
    if (take.status === "completed") throw new ValidationError("completed take cannot be submitted");
    if (!(await hasAudio(user.id, takeId, take.songId))) throw new ValidationError("audio blob missing");
    if (take.status === "queued" || take.status === "transcribing" || take.status === "aligning" || take.status === "scoring") {
      return jsonResponse({ takeId, status: take.status, estimatedSeconds: Math.max(30, Math.round(take.durationSec * 1.5)) }, request, { status: 202 });
    }
    await updateTake(takeId, { status: "queued", progress: 0, failure: null }, user.id);
    await getAnalysisQueue().enqueue({
      schemaVersion: 1,
      jobId: randomUUID(),
      takeId,
      songId: take.songId,
      userId: user.id,
      attempt: 1,
      correlationId: request.headers.get("x-request-id") ?? randomUUID(),
      pipelineVersion: "local-v1",
    });
    return jsonResponse({
      takeId, status: "queued", estimatedSeconds: Math.max(30, Math.round(take.durationSec * 1.5)), queuePosition: 1,
    }, request, { status: 202 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
