import { randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { getConfig } from "@/lib/server/config";
import { errorResponse, jsonResponse, NotFoundError, ValidationError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong, saveScoreFile, updateSong } from "@/lib/server/repository";
import { runOmrWorker } from "@/lib/server/worker";
import { getScoreQueue } from "@/lib/server/queue";

export const runtime = "nodejs";

const ALLOWED_EXT = [".musicxml", ".xml", ".mxl", ".mid", ".midi", ".pdf"];
const MAX_SIZE = 10 * 1024 * 1024;

function hasValidSignature(ext: string, bytes: Buffer): boolean {
  if (ext === ".pdf") return bytes.subarray(0, 5).toString() === "%PDF-";
  if (ext === ".mxl") return bytes.subarray(0, 2).toString() === "PK";
  if (ext === ".mid" || ext === ".midi") return bytes.subarray(0, 4).toString() === "MThd";
  const prefix = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<") && (prefix.includes("score-partwise") || prefix.includes("score-timewise"));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    if (!(await getSong(songId, user.id))) throw new NotFoundError("song not found");

    const formData = await request.formData();
    const file = formData.get("scoreFile");
    if (!(file instanceof File)) throw new ValidationError("scoreFile is required");
    const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!ALLOWED_EXT.includes(ext)) throw new ValidationError(`unsupported extension: ${ext}`);
    if (file.size === 0 || file.size > MAX_SIZE) throw new ValidationError("scoreFileSize must be > 0 and <= 10MB");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!hasValidSignature(ext, bytes)) throw new ValidationError("score file signature is invalid");

    await saveScoreFile(songId, file.name, bytes, user.id);
    if (ext === ".pdf") {
      await updateSong(songId, {
        status: "converting_score",
        scoreFileName: file.name,
        sourceScoreFileName: file.name,
        scoreSource: "pdf",
        omrEngine: "audiveris",
        omrError: undefined,
      }, user.id);
      if (getConfig().storageBackend === "azure") {
        return jsonResponse({ songId, status: "converting_score", uploadComplete: true }, request, { status: 202 });
      }
      const result = await runOmrWorker(songId);
      const updated = await getSong(songId, user.id);
      if (!updated) throw new NotFoundError("song not found");
      return jsonResponse({
        songId: updated.id,
        status: updated.status,
        omrError: result.code === 0 ? undefined : updated.omrError ?? "PDF conversion failed",
      }, request, { status: result.code === 0 ? 202 : 200 });
    }

    await updateSong(songId, {
      status: "parsing_score",
      scoreSource: ext === ".mid" || ext === ".midi" ? "midi" : "musicxml",
      sourceScoreFileName: file.name,
      omrEngine: null,
      omrError: undefined,
      lastScoreError: undefined,
    }, user.id);
    await getScoreQueue().enqueue({
      schemaVersion: 1,
      jobId: randomUUID(),
      songId,
      userId: user.id,
      attempt: 1,
      correlationId: request.headers.get("x-request-id") ?? randomUUID(),
    });
    // 参照譜の生成はワーカーが行う（Issue #33）。ストレージバックエンドで分岐しない ──
    // ローカルでしか通らない経路を作らないことが、この変更の目的そのもの。
    return jsonResponse({ songId, status: "parsing_score", uploadComplete: true }, request, { status: 202 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
