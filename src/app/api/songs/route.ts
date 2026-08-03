import { createSong, listSongs } from "@/lib/server/repository";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, readJson } from "@/lib/server/http";
import { createSongSchema, parseSchema } from "@/lib/server/validation";
import { getConfig } from "@/lib/server/config";
import { getBlobStore } from "@/lib/server/blob-storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await getAuthenticatedUser(request);
    return jsonResponse({ songs: await listSongs(user.id) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser(request);
    const input = parseSchema(createSongSchema, await readJson(request));
    const song = await createSong(input, user.id);
    const response: { songId: string; status: string; song: typeof song; upload?: unknown } = {
      songId: song.id, status: song.status, song,
    };
    if (getConfig().storageBackend === "azure") {
      response.upload = await getBlobStore().createWriteSas(
        getConfig().scoresContainer,
        `users/${user.id}/songs/${song.id}/scores/score.musicxml`,
        { contentType: "application/xml", maxBytes: 10 * 1024 * 1024 }
      );
    }
    return jsonResponse(response, request, { status: 201 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
