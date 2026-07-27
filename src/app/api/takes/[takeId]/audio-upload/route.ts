import { NextResponse } from "next/server";
import { getTake, saveAudioFile } from "@/lib/server/repository";

export const runtime = "nodejs";

const MAX_SIZE = 100 * 1024 * 1024; // 100 MB (api.md 5.2)

// POST /api/takes/{takeId}/audio-upload — 音声アップロード
// ローカル簡略版: api.md ではSAS直PUTだが、ここでは直接multipartで受け取る。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  const { takeId } = await params;
  const take = await getTake(takeId);
  if (!take) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "take not found" } },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("audioFile");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "audioFile is required" } },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "fileSize must be <= 100MB" } },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  await saveAudioFile(takeId, file.name || "original.webm", bytes);
  const updated = await getTake(takeId);

  return NextResponse.json({ takeId, status: updated?.status });
}
