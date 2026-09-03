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
    if (!(await hasAudio(user.id, takeId, take.songId))) throw new ValidationError("audio blob missing");
    if (take.status === "queued" || take.status === "transcribing" || take.status === "aligning" || take.status === "scoring" || take.status === "reviewing") {
      return jsonResponse({ takeId, status: take.status, estimatedSeconds: Math.max(30, Math.round(take.durationSec * 1.5)) }, request, { status: 202 });
    }
    // failed/completed -> queued の再解析。完了済みテイクも採点ポリシーの更新時に
    // 元音声から再採点できる。evaluation/analysis や指標系フィールドが残ったままでは、
    // status/progress/failure だけをリセットすると、再解析が終わるまでの間、
    // 「queued なのに古い evaluation が残る」という誤解を招く表示になる。
    // ここでリセットする値は createTake() の初期値（src/lib/server/repository.ts）
    // と揃える ── 解析パイプラインの成功パス（worker/worker_main.py の
    // completed 分岐）がテイク作成後に書き込むのと同じフィールド集合。
    await updateTake(
      takeId,
      {
        status: "queued",
        progress: 0,
        failure: null,
        overallScore: null,
        metrics: null,
        metricConfidence: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
        metricEvaluations: {},
        metricsNAReason: {},
        evaluation: null,
        measureScores: [],
        issues: [],
        aiReview: null,
        analysis: null,
      },
      user.id
    );
    try {
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
    } catch (error) {
      await updateTake(
        takeId,
        {
          status: "failed",
          failure: {
            code: "QUEUE_UNAVAILABLE",
            message: "再解析を開始できませんでした。少し時間を置いてからもう一度お試しください。",
          },
        },
        user.id,
      );
      throw error;
    }
    return jsonResponse({
      takeId, status: "queued", estimatedSeconds: Math.max(30, Math.round(take.durationSec * 1.5)), queuePosition: 1,
    }, request, { status: 202 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
