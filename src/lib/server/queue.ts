import { QueueClient, QueueServiceClient } from "@azure/storage-queue";
import { getConfig } from "./config";
import { getTelemetry } from "./observability";
import { updateTake } from "./repository";
import { createAzureCredential } from "./azure-credential";

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
    runAnalyzeWorkerAsync(job.takeId);
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
    const metrics = { pitch: 82, rhythm: 78, tempo: 80, dynamics: 75, pedal: null };
    await updateTake(job.takeId, { status: "transcribing", progress: 0.25 }, job.userId);
    await updateTake(job.takeId, { status: "aligning", progress: 0.55 }, job.userId);
    await updateTake(job.takeId, { status: "scoring", progress: 0.8 }, job.userId);
    await updateTake(job.takeId, {
      status: "completed",
      progress: 1,
      overallScore: 79,
      metrics,
      metricsNAReason: { pedal: "deterministic local analysis does not measure pedal" },
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
