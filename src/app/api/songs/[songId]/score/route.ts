import { NextResponse } from "next/server";
import { getSong, saveScoreFile } from "@/lib/server/repository";
import { runReferenceWorker } from "@/lib/server/worker";

export const runtime = "nodejs";

const ALLOWED_EXT = [".musicxml", ".xml", ".mxl", ".mid", ".midi"];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB (api.md 5.1)

// POST /api/songs/{songId}/score — 楽譜アップロード + 登録完了通知 (api.md 5.1 #9)
// ローカル簡略版: SASアップロードの代わりにこのエンドポイントへ直接multipartで送る。
// サーバーはMusicXMLを解析し reference.json を生成する（同期処理、通常1-3秒）。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  const { songId } = await params;
  const song = await getSong(songId);
  if (!song) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "song not found" } },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("scoreFile");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "scoreFile is required" } },
      { status: 400 }
    );
  }

  const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: `unsupported extension: ${ext}`,
        },
      },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "scoreFileSize must be <= 10MB" } },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  await saveScoreFile(songId, file.name, bytes);

  const result = await runReferenceWorker(songId);
  const updated = await getSong(songId);

  if (result.code !== 0 || updated?.status !== "ready") {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: updated?.lastScoreError ?? "score parsing failed",
          details: { stderr: result.stderr.slice(-2000) },
        },
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    songId: updated.id,
    status: updated.status,
    measureCount: updated.measureCount,
    scoreMeasureCount: updated.scoreMeasureCount,
    keySignature: updated.keySignature,
    timeSignature: updated.timeSignature,
    detectedTempo: updated.detectedTempo,
    hasRepeats: updated.hasRepeats,
    warnings: updated.warnings,
  });
}
