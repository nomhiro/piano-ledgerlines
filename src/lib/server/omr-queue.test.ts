import assert from "node:assert/strict";
import test from "node:test";

import { getConfig, resetConfigForTests } from "./config";

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
