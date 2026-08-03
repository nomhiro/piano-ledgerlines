import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getTake, saveAudioFile } from "@/lib/server/repository";

export const runtime = "nodejs";

const MAX_SIZE = 100 * 1024 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/wav", "audio/wave", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg"]);

function validAudioSignature(type: string, bytes: Buffer): boolean {
  if (type === "audio/wav" || type === "audio/wave" || type === "audio/x-wav") {
    return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
  }
  if (type === "audio/mpeg") return bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 0xff;
  if (type === "audio/mp4") return bytes.subarray(4, 8).toString() === "ftyp";
  if (type === "audio/ogg") return bytes.subarray(0, 4).toString() === "OggS";
  return bytes.length > 4;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    if (!(await getTake(takeId, user.id))) throw new NotFoundError("take not found");
    const formData = await request.formData();
    const file = formData.get("audioFile");
    if (!(file instanceof File)) throw new ValidationError("audioFile is required");
    if (file.size === 0 || file.size > MAX_SIZE) throw new ValidationError("fileSize must be > 0 and <= 100MB");
    const contentType = file.type.toLowerCase();
    if (!AUDIO_TYPES.has(contentType.split(";")[0])) throw new ValidationError("unsupported audio content type");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!validAudioSignature(contentType, bytes)) throw new ValidationError("audio file signature is invalid");
    await saveAudioFile(takeId, file.name || "original.webm", bytes, user.id);
    const updated = await getTake(takeId, user.id);
    return jsonResponse({ takeId, status: updated?.status }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
