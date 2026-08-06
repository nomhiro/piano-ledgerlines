import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong } from "@/lib/server/repository";

export const runtime = "nodejs";

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
      throw new ValidationError(
        "PDFからの自動変換は分析には使用できません。正しいMusicXML、MXL、またはMIDIへ差し替えてください。"
      );
    }
    throw new ValidationError("score approval is only available for a verified score");
  } catch (error) {
    return errorResponse(request, error);
  }
}
