// 実バックエンドAPIクライアント（ブラウザから fetch する用）。
// src/lib/mock/ のダミーデータの代わりに、この縦串フェーズで実装した
// src/app/api/* を呼び出す。api.md 記載のSAS直アップロードの代わりに、
// ローカル簡略版として直接multipartでファイルを送る2ステップ構成にしている。
export interface ApiSong {
  id: string;
  title: string;
  composer: string;
  targetTempo: number | null;
  status: "awaiting_score" | "parsing_score" | "converting_score" | "reviewing_score" | "omr_failed" | "ready";
  measureCount: number | null;
  timeSignature: string | null;
  keySignature: string | null;
  detectedTempo: number | null;
  /** OSMD で描ける MusicXML プレビューのファイル名。null なら楽譜を描けない。 */
  previewScoreFileName: string | null;
  warnings: { code: string; message: string; measures?: number[] }[];
}

/**
 * `GET /api/songs/{songId}` と `GET /api/songs/{songId}/takes` が返すテイク。
 *
 * どちらのルートもテイクの文書をそのまま返すため実際のレスポンスはこれより広い。
 * ここでは画面が使うフィールドだけを宣言している。識別子のキーは `takeId` では
 * なく `id`（`src/app/api/songs/[songId]/route.ts:18`）。
 */
export interface ApiTakeSummary {
  id: string;
  label: string;
  recordedAt: string;
  status: string;
  overallScore: number | null;
}

export type ApiEvaluationStatus = "scored" | "reference" | "withheld" | "unavailable";

export interface ApiMetricEvaluation {
  status: ApiEvaluationStatus;
  confidence: number | null;
  reasonCode: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export interface ApiTakeDetail {
  id: string;
  songId: string;
  label: string;
  /** 録音日時（ISO8601）。`src/app/api/takes/[takeId]/route.ts:19` が返している。 */
  recordedAt: string;
  status: string;
  progress: number;
  failure: { code: string; message: string } | null;
  overallScore: number | null;
  metrics: Record<string, number | null> | null;
  metricConfidence: Record<string, number | null>;
  metricEvaluations: Record<string, ApiMetricEvaluation>;
  metricsNAReason: Record<string, string>;
  evaluation: {
    status: "scored" | "withheld";
    confidence: number | null;
    reasonCode: string | null;
    reason: string | null;
    calibrationVersion: string | null;
  } | null;
  measureScores: {
    measure: number;
    /** 楽譜上の小節番号（docs/spec/api.md:72）。繰り返しが無い曲では measure と一致する。 */
    scoreMeasure: number;
    score: number | null;
    confidence: number | null;
    metrics: Record<string, number | null>;
    metricEvaluations: Record<string, ApiMetricEvaluation>;
  }[];
  issues: {
    id: string;
    kind: string;
    severity: "high" | "medium" | "low";
    measures: number[];
    summary: string;
    metric: string;
    confidence?: number | null;
    observation?: string;
    evidence?: Record<string, unknown>;
    practiceAction?: string;
  }[];
  aiReview: unknown;
  memo: string;
}

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) {
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export async function createSong(input: {
  title: string;
  composer: string;
  targetTempo?: number | null;
}): Promise<{ songId: string; status: string; song: ApiSong }> {
  const res = await fetch("/api/songs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function uploadScore(
  songId: string,
  file: File
): Promise<{
  songId: string;
  status: string;
  measureCount?: number;
  keySignature?: string;
  timeSignature?: string;
  detectedTempo?: number;
  warnings?: { code: string; message: string; measures?: number[] }[];
  omrError?: string;
}> {
  const form = new FormData();
  form.append("scoreFile", file, file.name);
  const res = await fetch(`/api/songs/${songId}/score`, { method: "POST", body: form });
  return asJson(res);
}

export async function getSong(
  songId: string
): Promise<{ song: ApiSong; takes: ApiTakeSummary[] }> {
  const res = await fetch(`/api/songs/${songId}`);
  return asJson(res);
}

export async function updateSong(
  songId: string,
  input: {
    title?: string;
    composer?: string;
    targetTempo?: number | null;
    targetDate?: string | null;
  },
): Promise<{ song: ApiSong }> {
  const res = await fetch(`/api/songs/${songId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function deleteSong(songId: string): Promise<{ songId: string; deleted: true }> {
  const res = await fetch(`/api/songs/${songId}`, { method: "DELETE" });
  return asJson(res);
}

export async function createTake(
  songId: string,
  input: {
    label: string;
    recordedAt: string;
    durationSec: number;
    requestedMeasureRange: [number, number];
    requestedTempo?: number | null;
    inputKind: "audio" | "midi";
    contentType: string | null;
  }
): Promise<{ takeId: string; status: string }> {
  const res = await fetch(`/api/songs/${songId}/takes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson(res);
}

export async function uploadTakeAudio(
  takeId: string,
  blob: Blob,
  fileName: string
): Promise<{ takeId: string; status: string }> {
  const form = new FormData();
  form.append("audioFile", blob, fileName);
  const res = await fetch(`/api/takes/${takeId}/audio-upload`, {
    method: "POST",
    body: form,
  });
  return asJson(res);
}

export async function submitTake(
  takeId: string
): Promise<{ takeId: string; status: string; estimatedSeconds: number }> {
  const res = await fetch(`/api/takes/${takeId}/submit`, { method: "POST" });
  return asJson(res);
}

export async function getTake(takeId: string): Promise<ApiTakeDetail> {
  const res = await fetch(`/api/takes/${takeId}`);
  return asJson(res);
}

/**
 * SSEで進捗を購読する。EventSourceはGETしか使えず認証ヘッダーも
 * 付けられないため、ローカル縦串フェーズのモック認証とは相性がよい
 * （本番はEntra IDのクエリトークン等を検討）。
 */
export function subscribeTakeEvents(
  takeId: string,
  onStatus: (data: { status: string; progress?: number; scoresReady?: boolean }) => void,
  onDone: (data: { status: string }) => void,
  onError: (message: string) => void,
): () => void {
  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollFailures = 0;
  const es = new EventSource(`/api/takes/${takeId}/events`);

  const stop = () => {
    stopped = true;
    es.close();
    if (pollTimer) clearTimeout(pollTimer);
  };
  const finish = (status: string) => {
    if (stopped) return;
    stop();
    onDone({ status });
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const take = await getTake(takeId);
      if (stopped) return;
      pollFailures = 0;
      onStatus({ status: take.status, progress: take.progress, scoresReady: take.status === "completed" });
      if (take.status === "completed" || take.status === "failed") {
        finish(take.status);
        return;
      }
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= 3) {
        stop();
        onError(error instanceof Error ? error.message : "分析状況を取得できませんでした。");
        return;
      }
    } finally {
      polling = false;
    }
    if (!stopped) pollTimer = setTimeout(() => void poll(), 1000);
  };

  es.addEventListener("status", (ev) => {
    onStatus(JSON.parse((ev as MessageEvent).data));
  });
  es.addEventListener("done", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as { status: string };
    finish(data.status);
  });
  es.addEventListener("analysis-error", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as { message?: string };
    stop();
    onError(data.message ?? "分析状況を取得できませんでした。");
  });
  es.onerror = () => {
    es.close();
    void poll();
  };
  return stop;
}
