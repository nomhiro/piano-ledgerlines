import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { CoachInput } from "../src/lib/server/ai-coach";

const input: CoachInput = {
  song: { title: "Local smoke song", composer: "Smoke", keySignature: "C", timeSignature: "4/4", targetTempo: 96 },
  take: {
    label: "smoke take",
    recordedAt: new Date().toISOString(),
    requestedMeasureRange: [1, 8],
    playedMeasureRange: [1, 8],
    overallScore: 79,
    metrics: { pitch: 82, rhythm: 78, tempo: 80, dynamics: 75, pedal: null },
    metricEvaluations: {},
    metricsNAReason: {},
  },
  issues: [],
  history: [],
};
type SmokeBody = {
  songId?: string;
  takeId?: string;
  status?: string;
  upload?: { url?: string };
  review?: { practiceMenu?: unknown[] };
  failure?: unknown;
};

async function deterministicSmoke(): Promise<void> {
  process.env.LEDGERLINES_AUTH_MODE = "development";
  const smokeData = path.join(process.cwd(), ".data-smoke");
  process.env.LEDGERLINES_DATA_DIR = smokeData;
  const [{ fallbackReview, coachReviewSchema }, { LocalBlobStore }, { LocalRepository }] = await Promise.all([
    import("../src/lib/server/ai-coach"),
    import("../src/lib/server/blob-storage"),
    import("../src/lib/server/repository"),
  ]);
  try {
    const repository = new LocalRepository();
    const storage = new LocalBlobStore();
    const song = await repository.createSong("usr_local_smoke", { title: "Local smoke song", composer: "Smoke" });
    await repository.saveScoreFile("usr_local_smoke", song.id, "score.musicxml", Buffer.from("<score-partwise/>"));
    const take = await repository.createTake("usr_local_smoke", song.id, {
      label: "smoke take",
      recordedAt: new Date().toISOString(),
      durationSec: 5,
      requestedMeasureRange: [1, 8],
      inputKind: "audio",
      contentType: "audio/webm",
    });
    await storage.upload("audio", `${take.id}/original.webm`, Buffer.from("smoke-audio"), "audio/webm");
    await repository.updateTake("usr_local_smoke", take.id, { status: "uploaded" });
    for (const status of ["queued", "transcribing", "aligning", "scoring", "completed"] as const) {
      await repository.updateTake("usr_local_smoke", take.id, {
        status,
        progress: status === "completed" ? 1 : 0.5,
        ...(status === "completed" ? {
          overallScore: 79,
          metrics: input.take.metrics,
          metricsNAReason: { pedal: "deterministic" },
        } : {}),
      });
    }
    const review = coachReviewSchema.parse(fallbackReview(input));
    const result = await repository.getTake("usr_local_smoke", take.id);
    assert.equal(result?.status, "completed");
    assert.equal(result?.overallScore, 79);
    assert.ok(review.practiceMenu.length >= 2);
    console.log("Deterministic local smoke passed: song -> score -> take -> upload -> queue -> status -> coach.");
  } finally {
    await fs.rm(smokeData, { recursive: true, force: true });
  }
}

async function httpSmoke(baseUrl: string): Promise<void> {
  const json = async (path: string, init: RequestInit = {}): Promise<SmokeBody> => {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = await response.json() as SmokeBody;
    assert.ok(response.ok || response.status === 202, `${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const songResponse = await json("/api/songs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "HTTP smoke song", composer: "Smoke", targetTempo: 96 }),
  });
  const songId = songResponse.songId;
  assert.ok(songId);
  if (songResponse.upload?.url) {
    const score = "<score-partwise version=\"4.0\"><part-list/><part id=\"P1\"/></score-partwise>";
    const upload = await fetch(songResponse.upload.url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/xml" },
      body: score,
    });
    assert.ok(upload.ok, `score upload failed: ${upload.status}`);
    await json(`/api/songs/${songId}/score/complete`, { method: "POST" });
  }
  const takeResponse = await json(`/api/songs/${songId}/takes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "HTTP smoke take", durationSec: 5, requestedMeasureRange: [1, 8],
      inputKind: "audio", contentType: "audio/webm",
    }),
  });
  const takeId = takeResponse.takeId;
  assert.ok(takeId);
  const form = new FormData();
  form.set("audioFile", new Blob([Buffer.from("smoke-audio")], { type: "audio/webm" }), "original.webm");
  await json(`/api/takes/${takeId}/audio-upload`, { method: "POST", body: form });
  await json(`/api/takes/${takeId}/upload-complete`, { method: "POST" });
  await json(`/api/takes/${takeId}/submit`, { method: "POST" });
  let status: string | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const take = await json(`/api/takes/${takeId}`);
    status = take.status;
    if (status === "completed") break;
    if (status === "failed") throw new Error(`analysis failed: ${JSON.stringify(take.failure)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (process.env.SMOKE_EXPECT_QUEUED === "true") {
    assert.equal(status, "queued");
    console.log("HTTP Azure cloud smoke passed through queue submission; worker is intentionally not provisioned.");
    return;
  }
  assert.equal(status, "completed");
  const coach = await json(`/api/takes/${takeId}/coach`, { method: "POST" });
  assert.ok((coach.review?.practiceMenu?.length ?? 0) >= 2);
  console.log("HTTP local Azure smoke passed: song -> score -> take -> upload -> queue -> status -> coach.");
}

async function main(): Promise<void> {
  if (process.env.SMOKE_MODE === "http") {
    await httpSmoke(process.env.SMOKE_BASE_URL ?? "http://localhost:3000");
    return;
  }
  await deterministicSmoke();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
