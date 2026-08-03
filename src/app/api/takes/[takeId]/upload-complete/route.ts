import fs from "node:fs/promises";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { getBlobStore } from "@/lib/server/blob-storage";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { audioDir } from "@/lib/server/paths";
import { getTake, updateTake } from "@/lib/server/repository";

export const runtime = "nodejs";

async function uploaded(userId: string, takeId: string, songId: string): Promise<boolean> {
  const config = getConfig();
  if (config.storageBackend === "azure") {
    const prefix = `users/${userId}/songs/${songId}/takes/${takeId}/original`;
    for (const ext of [".webm", ".wav", ".mp3", ".mp4", ".ogg"]) {
      if (await getBlobStore().exists(config.audioContainer, `${prefix}${ext}`)) return true;
    }
    return false;
  }
  try {
    return (await fs.readdir(audioDir(takeId))).some((name) => name.startsWith("original."));
  } catch {
    return false;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ takeId: string }> }) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    const take = await getTake(takeId, user.id);
    if (!take) throw new NotFoundError("take not found");
    if (!(await uploaded(user.id, takeId, take.songId))) throw new ValidationError("audio blob missing");
    const updated = await updateTake(takeId, { status: "uploaded" }, user.id);
    return jsonResponse({ takeId, status: updated.status }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
