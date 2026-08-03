import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, NotFoundError, readJson } from "@/lib/server/http";
import { assertResourceId, parseSchema, updateSongSchema } from "@/lib/server/validation";
import { deleteSong, getSong, listTakesBySong, updateSong } from "@/lib/server/repository";

export const runtime = "nodejs";

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
    return jsonResponse({ song, takes: await listTakesBySong(songId, user.id) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    const song = await updateSong(songId, parseSchema(updateSongSchema, await readJson(request)), user.id);
    return jsonResponse({ song }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    if (!(await getSong(songId, user.id))) throw new NotFoundError("song not found");
    await deleteSong(songId, user.id);
    return jsonResponse({ songId, deleted: true }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
