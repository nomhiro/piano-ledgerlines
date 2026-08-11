import assert from "node:assert/strict";
import test from "node:test";
import { coachReviewSchema, fallbackReview, type CoachInput } from "../src/lib/server/ai-coach";
import { redactTelemetry } from "../src/lib/server/observability";
import { assertTakeTransition } from "../src/lib/server/take-state";
import { getConfig, resetConfigForTests } from "../src/lib/server/config";
import { getAuthenticatedUser } from "../src/lib/server/auth";

const input: CoachInput = {
  song: {
    title: "Test piece",
    composer: "Composer",
    keySignature: "C",
    timeSignature: "4/4",
    targetTempo: 100,
  },
  take: {
    label: "take",
    recordedAt: new Date().toISOString(),
    requestedMeasureRange: [1, 8],
    playedMeasureRange: [1, 8],
    overallScore: 70,
    metrics: { pitch: 70, rhythm: 65, tempo: 72, dynamics: null, pedal: null },
    metricEvaluations: {},
    metricsNAReason: {},
  },
  issues: [],
  history: [],
};

test("telemetry redaction removes credentials and user text", () => {
  const event = redactTelemetry({
    name: "request",
    authorization: "Bearer eyJvery-secret-token",
    sasUrl: "https://blob.test/a?sig=secret&se=secret",
    memo: "private practice note",
    takeId: "take-1",
  });
  assert.equal(event.authorization, "[REDACTED]");
  assert.equal(event.memo, "[REDACTED]");
  assert.equal(event.takeId, "take-1");
  assert.match(String(event.sasUrl), /\[REDACTED\]/);
});

test("fallback coach output satisfies the structured review contract", () => {
  const review = coachReviewSchema.parse(fallbackReview(input));
  assert.ok(review.practiceMenu.length >= 2);
  for (const item of review.practiceMenu) {
    assert.ok(item.measures.every((measure) => measure >= 1 && measure <= 8));
  }
});

test("take status transitions reject invalid regressions", () => {
  assert.doesNotThrow(() => assertTakeTransition("scoring", "completed"));
  assert.throws(() => assertTakeTransition("completed", "queued"), /invalid take status transition/);
});

test("Foundry configuration fails closed when enabled without endpoint", () => {
  const previous = {
    enabled: process.env.LEDGERLINES_FOUNDRY_ENABLED,
    endpoint: process.env.AZURE_FOUNDRY_ENDPOINT,
    deployment: process.env.AZURE_FOUNDRY_DEPLOYMENT,
    auth: process.env.LEDGERLINES_AUTH_MODE,
  };
  process.env.LEDGERLINES_FOUNDRY_ENABLED = "true";
  delete process.env.AZURE_FOUNDRY_ENDPOINT;
  delete process.env.AZURE_FOUNDRY_DEPLOYMENT;
  process.env.LEDGERLINES_AUTH_MODE = "development";
  resetConfigForTests();
  assert.throws(() => getConfig(), /AZURE_FOUNDRY_ENDPOINT/);
  if (previous.enabled === undefined) delete process.env.LEDGERLINES_FOUNDRY_ENABLED;
  else process.env.LEDGERLINES_FOUNDRY_ENABLED = previous.enabled;
  if (previous.endpoint === undefined) delete process.env.AZURE_FOUNDRY_ENDPOINT;
  else process.env.AZURE_FOUNDRY_ENDPOINT = previous.endpoint;
  if (previous.deployment === undefined) delete process.env.AZURE_FOUNDRY_DEPLOYMENT;
  else process.env.AZURE_FOUNDRY_DEPLOYMENT = previous.deployment;
  if (previous.auth === undefined) delete process.env.LEDGERLINES_AUTH_MODE;
  else process.env.LEDGERLINES_AUTH_MODE = previous.auth;
  resetConfigForTests();
});

test("production rejects emulator and local cloud profiles", () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    phase: process.env.NEXT_PHASE,
    cloud: process.env.LEDGERLINES_AZURE_CLOUD,
    emulator: process.env.LEDGERLINES_AZURE_EMULATOR,
  };
  env.NODE_ENV = "production";
  delete process.env.NEXT_PHASE;

  process.env.LEDGERLINES_AZURE_EMULATOR = "true";
  delete process.env.LEDGERLINES_AZURE_CLOUD;
  resetConfigForTests();
  assert.throws(() => getConfig(), /LEDGERLINES_AZURE_EMULATOR cannot be enabled in production/);

  delete process.env.LEDGERLINES_AZURE_EMULATOR;
  process.env.LEDGERLINES_AZURE_CLOUD = "true";
  resetConfigForTests();
  assert.throws(() => getConfig(), /LEDGERLINES_AZURE_CLOUD.*production/);

  if (previous.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous.nodeEnv;
  if (previous.phase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = previous.phase;
  if (previous.cloud === undefined) delete process.env.LEDGERLINES_AZURE_CLOUD;
  else process.env.LEDGERLINES_AZURE_CLOUD = previous.cloud;
  if (previous.emulator === undefined) delete process.env.LEDGERLINES_AZURE_EMULATOR;
  else process.env.LEDGERLINES_AZURE_EMULATOR = previous.emulator;
  resetConfigForTests();
});

test("Google Easy Auth principal resolves to the storage user id", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = {
    auth: process.env.LEDGERLINES_AUTH_MODE,
    nodeEnv: process.env.NODE_ENV,
  };
  env.NODE_ENV = "production";
  process.env.LEDGERLINES_AUTH_MODE = "google";
  resetConfigForTests();
  const principal = Buffer.from(JSON.stringify({
    userId: "100007109722337889200",
    identityProvider: "google",
  })).toString("base64");
  const user = await getAuthenticatedUser(new Request("http://localhost", {
    headers: { "x-ms-client-principal": principal },
  }));
  assert.equal(user.id, "google:100007109722337889200");
  if (previous.auth === undefined) delete process.env.LEDGERLINES_AUTH_MODE;
  else process.env.LEDGERLINES_AUTH_MODE = previous.auth;
  if (previous.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous.nodeEnv;
  resetConfigForTests();
});
