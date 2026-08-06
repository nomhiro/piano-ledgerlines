import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, readJson, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId, createTakeSchema, parseSchema } from "@/lib/server/validation";
import { createTake, getSong, listTakesBySong } from "@/lib/server/repository";
import { getConfig } from "@/lib/server/config";
import { getBlobStore } from "@/lib/server/blob-storage";
import { assertTakeQuota } from "@/lib/server/quota";

export const runtime = "nodejs";

// GET /api/songs/{songId}/takes — テイク一覧 (api.md #13)
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
    return jsonResponse({ takes: await listTakesBySong(songId, user.id) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

// POST /api/songs/{songId}/takes — テイク作成 (api.md 5.2 #14)
// ローカル簡略版: アップロードURL発行の代わりに、この直後
// `POST /api/takes/{takeId}/audio-upload` へ直接multipartで音声を送ってもらう。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    const song = await getSong(songId, user.id);
    if (!song) throw new NotFoundError("song not found");
    if (song.scoreSource === "pdf") {
      throw new ValidationError("PDFからの自動変換は分析に使用できません。正しいMusicXML、MXL、またはMIDIへ差し替えてください。");
    }
    if (song.status !== "ready") {
      throw new ValidationError("score must be ready before creating a take");
    }
    const input = parseSchema(createTakeSchema, await readJson(request));
    await assertTakeQuota(user.id, user.plan);
    if (song.measureCount !== null && input.requestedMeasureRange[1] > song.measureCount) {
      return errorResponse(request, new Error("requestedMeasureRange exceeds song measure count"));
    }
    const take = await createTake(songId, {
      ...input,
      requestedMeasureRange: [input.requestedMeasureRange[0], input.requestedMeasureRange[1]],
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      requestedTempo: input.requestedTempo ?? null,
      contentType: input.contentType ?? null,
    }, user.id);
    const response: { takeId: string; status: string; take: typeof take; upload?: unknown } = {
      takeId: take.id, status: take.status, take,
    };
    if (getConfig().storageBackend === "azure") {
      response.upload = await getBlobStore().createWriteSas(
        getConfig().audioContainer,
        `users/${user.id}/songs/${songId}/takes/${take.id}/original.webm`,
        { contentType: input.contentType ?? "audio/webm", maxBytes: 100 * 1024 * 1024 }
      );
    }
    return jsonResponse(response, request, { status: 201 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
