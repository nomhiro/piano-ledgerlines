import { QueueClient, QueueServiceClient } from "@azure/storage-queue";
import { getConfig } from "./config";
import { getTelemetry } from "./observability";
import { updateTake } from "./repository";
import { createAzureCredential } from "./azure-credential";
import { deterministicAnalysisResult } from "./deterministic-analysis";

export interface AnalysisJob {
  schemaVersion: 1;
  jobId: string;
  takeId: string;
  songId: string;
  userId: string;
  attempt: number;
  correlationId: string;
  pipelineVersion: string;
}

export interface AnalysisQueue {
  enqueue(job: AnalysisJob): Promise<void>;
}

export class LocalAnalysisQueue implements AnalysisQueue {
  async enqueue(job: AnalysisJob): Promise<void> {
    // Keep the process-spawn implementation strictly behind the local backend.
    const { runAnalyzeWorkerAsync } = await import("./worker");
    runAnalyzeWorkerAsync(job.takeId, job.userId);
    getTelemetry().record({ name: "analysis.queue.enqueued", jobId: job.jobId, takeId: job.takeId, stage: "local" });
  }
}

export class AzureAnalysisQueue implements AnalysisQueue {
  private readonly client: QueueClient;

  constructor() {
    const config = getConfig();
    this.client = config.azureEmulator
      ? QueueServiceClient.fromConnectionString(config.storageConnectionString!).getQueueClient(config.analysisQueueName)
      : new QueueClient(
          `${config.storageQueueUrl ?? config.storageAccountUrl}/${config.analysisQueueName}`,
          createAzureCredential()
        );
  }

  async enqueue(job: AnalysisJob): Promise<void> {
    // Queue messages contain identifiers only, never audio, tokens, or SAS URLs.
    await this.client.sendMessage(JSON.stringify(job));
    getTelemetry().record({ name: "analysis.queue.enqueued", jobId: job.jobId, takeId: job.takeId, stage: "azure" });
    if (getConfig().azureEmulator && getConfig().deterministicAnalysis) {
      void runDeterministicAnalysis(job);
    }
  }
}

async function runDeterministicAnalysis(job: AnalysisJob): Promise<void> {
  try {
    // 書き込む値は deterministic-analysis.ts が持つ。metrics と metricEvaluations が
    // 食い違うと AIコーチが 400 になるため、対応関係はそこでテストに固定してある（#44）。
    const { overallScore, metrics, metricEvaluations, metricsNAReason } =
      deterministicAnalysisResult();
    await updateTake(job.takeId, { status: "transcribing", progress: 0.25 }, job.userId);
    await updateTake(job.takeId, { status: "aligning", progress: 0.55 }, job.userId);
    await updateTake(job.takeId, { status: "scoring", progress: 0.8 }, job.userId);
    await updateTake(job.takeId, {
      status: "completed",
      progress: 1,
      overallScore,
      metrics,
      metricEvaluations,
      metricsNAReason,
      measureScores: [],
      issues: [],
      analysis: { pipelineVersion: "local-azure-deterministic-v1", source: "emulator" },
      failure: null,
    }, job.userId);
  } catch (error) {
    getTelemetry().record({
      name: "analysis.deterministic.failed",
      takeId: job.takeId,
      jobId: job.jobId,
      failureCode: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
}

let queue: AnalysisQueue | undefined;
export function getAnalysisQueue(): AnalysisQueue {
  queue ??= getConfig().queueBackend === "azure" ? new AzureAnalysisQueue() : new LocalAnalysisQueue();
  return queue;
}

export function resetAnalysisQueueForTests(): void {
  queue = undefined;
}

export interface ScoreJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  userId: string;
  attempt: number;
  correlationId: string;
}

export interface ScoreQueue {
  enqueue(job: ScoreJob): Promise<void>;
}

export class LocalScoreQueue implements ScoreQueue {
  async enqueue(job: ScoreJob): Promise<void> {
    // プロセス spawn の実装はローカルバックエンドの内側に閉じる。API から見た
    // 契約（202 を返して進捗は別途購読する）は本番と同一にする。
    const { runReferenceWorkerAsync } = await import("./worker");
    runReferenceWorkerAsync(job.songId);
    getTelemetry().record({ name: "score.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "local" });
  }
}

export class AzureScoreQueue implements ScoreQueue {
  private readonly client: QueueClient;

  constructor() {
    const config = getConfig();
    this.client = config.azureEmulator
      ? QueueServiceClient.fromConnectionString(config.storageConnectionString!).getQueueClient(config.scoreQueueName)
      : new QueueClient(
          `${config.storageQueueUrl ?? config.storageAccountUrl}/${config.scoreQueueName}`,
          createAzureCredential()
        );
  }

  async enqueue(job: ScoreJob): Promise<void> {
    // 解析ジョブと同じ約束: メッセージは識別子だけを載せる。
    await this.client.sendMessage(JSON.stringify(job));
    getTelemetry().record({ name: "score.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "azure" });
  }
}

let scoreQueue: ScoreQueue | undefined;
export function getScoreQueue(): ScoreQueue {
  scoreQueue ??= getConfig().queueBackend === "azure" ? new AzureScoreQueue() : new LocalScoreQueue();
  return scoreQueue;
}

export function resetScoreQueueForTests(): void {
  scoreQueue = undefined;
}

export interface OmrJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  userId: string;
  attempt: number;
  correlationId: string;
}

export interface OmrQueue {
  enqueue(job: OmrJob): Promise<void>;
}

export class LocalOmrQueue implements OmrQueue {
  async enqueue(job: OmrJob): Promise<void> {
    // ローカルバックエンドは従来どおり同期実行(route が結果を返す)。ここは
    // azure バックエンドと契約を揃えるためのラッパーで、spawn の実装は
    // worker.ts の内側に閉じる。
    const { runOmrWorker } = await import("./worker");
    const result = await runOmrWorker(job.songId);
    // 戻り値を捨てると、失敗しても route は常に 202 を返してしまう。この
    // クラスは storageBackend=azure かつ queueBackend=local という組み合わせ
    // で到達し得るが、その組み合わせでは runOmrWorker がローカルの .data を
    // 見に行くのに曲は Cosmos にある——つまり支援された構成ではない。到達
    // したときに嘘の 202 で成功を装わないよう、失敗はここで例外にする。
    if (result.code !== 0) {
      throw new Error(`runOmrWorker failed for song ${job.songId} (exit code ${result.code})`);
    }
    getTelemetry().record({ name: "omr.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "local" });
  }
}

export class AzureOmrQueue implements OmrQueue {
  private readonly client: QueueClient;

  constructor() {
    const config = getConfig();
    this.client = config.azureEmulator
      ? QueueServiceClient.fromConnectionString(config.storageConnectionString!).getQueueClient(config.omrQueueName)
      : new QueueClient(
          `${config.storageQueueUrl ?? config.storageAccountUrl}/${config.omrQueueName}`,
          createAzureCredential()
        );
  }

  async enqueue(job: OmrJob): Promise<void> {
    // 解析・参照譜生成と同じ約束: メッセージは識別子だけを載せる。
    await this.client.sendMessage(JSON.stringify(job));
    getTelemetry().record({ name: "omr.queue.enqueued", jobId: job.jobId, songId: job.songId, stage: "azure" });
  }
}

let omrQueue: OmrQueue | undefined;
export function getOmrQueue(): OmrQueue {
  // route の分岐は storageBackend で決まるが、キューの選択は queueBackend で
  // 決まる。そのため storageBackend=azure かつ queueBackend=local という
  // 組み合わせでも route は azure 側に入り、ここは LocalOmrQueue を返す——
  // 「呼ばれない実装」ではない。ただしこの組み合わせは支援された構成ではない
  // (runOmrWorker はローカルの .data を見に行くが、曲は Cosmos にある)。
  // 到達したら黙って失敗を握り潰さずエラーにするのが LocalOmrQueue の役目。
  omrQueue ??= getConfig().queueBackend === "azure" ? new AzureOmrQueue() : new LocalOmrQueue();
  return omrQueue;
}

export function resetOmrQueueForTests(): void {
  omrQueue = undefined;
}
