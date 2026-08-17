import assert from "node:assert/strict";
import test from "node:test";

import { getConfig, resetConfigForTests } from "./config";
import { LocalOmrQueue } from "./queue";

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  resetConfigForTests();
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigForTests();
  }
}

test("OMR キュー名は未設定なら omr-jobs", () => {
  // ワーカー側（cloud_worker.omr_queue_name）と同じ既定値。片方だけ変えると
  // Web が投入したジョブを誰も読まない状態になる。
  withEnv({ AZURE_OMR_QUEUE: undefined }, () => {
    assert.equal(getConfig().omrQueueName, "omr-jobs");
  });
});

test("OMR キュー名が空文字でも omr-jobs にフォールバックする", () => {
  withEnv({ AZURE_OMR_QUEUE: "   " }, () => {
    assert.equal(getConfig().omrQueueName, "omr-jobs");
  });
});

test("OMR キュー名は明示されればそれを使う", () => {
  withEnv({ AZURE_OMR_QUEUE: "omr-jobs-stg" }, () => {
    assert.equal(getConfig().omrQueueName, "omr-jobs-stg");
  });
});

test("LocalOmrQueue.enqueue は runOmrWorker が失敗コードを返したら例外を投げる", async () => {
  // worker/worker_main.py はPythonスクリプトなので、WORKER_PYTHON を Node自身に
  // すり替えると「JSとして解釈できず即クラッシュ」= 非ゼロ終了コードを確実に
  // 再現できる。フェイクのpythonバイナリを新設せずに済む。
  const savedWorkerPython = process.env.WORKER_PYTHON;
  process.env.WORKER_PYTHON = process.execPath;
  try {
    const queue = new LocalOmrQueue();
    await assert.rejects(() =>
      queue.enqueue({
        schemaVersion: 1,
        jobId: "job-1",
        songId: "song-1",
        userId: "user-1",
        attempt: 1,
        correlationId: "corr-1",
      })
    );
  } finally {
    if (savedWorkerPython === undefined) delete process.env.WORKER_PYTHON;
    else process.env.WORKER_PYTHON = savedWorkerPython;
  }
});
