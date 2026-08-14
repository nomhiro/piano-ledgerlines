import assert from "node:assert/strict";
import test from "node:test";
import { coachReviewSchema, fallbackReview, type CoachInput } from "../src/lib/server/ai-coach";
import { redactTelemetry } from "../src/lib/server/observability";
import { assertTakeTransition } from "../src/lib/server/take-state";
import { getConfig, resetConfigForTests } from "../src/lib/server/config";
import { AuthError, getAuthenticatedUser, type AuthenticatedUser } from "../src/lib/server/auth";
import { buildAccountContext, createUserProfile, normalizeEmail } from "../src/lib/server/account";
import { GET as getAccount } from "../src/app/api/account/route";
import {
  LocalRepository,
  RepositoryConflictError,
} from "../src/lib/server/repository";
import { classroomMemberId } from "../src/lib/server/ids";
import type {
  BillingEventDoc,
  ClassroomDoc,
  ClassroomInvitationDoc,
  ClassroomMemberDoc,
} from "../src/lib/server/types";

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
    claims: [
      { typ: "email", val: "nomhiro@example.com" },
      { typ: "name", val: "Nomhiro User" },
    ],
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

test("Google Easy Auth claims resolve when the principal omits userId", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = {
    auth: process.env.LEDGERLINES_AUTH_MODE,
    nodeEnv: process.env.NODE_ENV,
  };
  env.NODE_ENV = "production";
  process.env.LEDGERLINES_AUTH_MODE = "google";
  resetConfigForTests();
  const principal = Buffer.from(JSON.stringify({
    auth_typ: "Google",
    claims: [
      { typ: "sub", val: "100007109722337889200" },
      { typ: "email", val: "nomhiro@example.com" },
      { typ: "name", val: "Nomhiro User" },
    ],
  })).toString("base64");
  const user = await getAuthenticatedUser(new Request("http://localhost", {
    headers: {
      "x-ms-client-principal": principal,
      "x-ms-client-principal-id": "100007109722337889200",
    },
  }));
  assert.equal(user.id, "google:100007109722337889200");
  if (previous.auth === undefined) delete process.env.LEDGERLINES_AUTH_MODE;
  else process.env.LEDGERLINES_AUTH_MODE = previous.auth;
  if (previous.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous.nodeEnv;
  resetConfigForTests();
});

test("Easy Auth rejects missing or invalid identity claims", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = { auth: env.LEDGERLINES_AUTH_MODE, nodeEnv: env.NODE_ENV };
  env.NODE_ENV = "production";
  env.LEDGERLINES_AUTH_MODE = "google";
  resetConfigForTests();
  const missingEmail = Buffer.from(JSON.stringify({
    userId: "user-1",
    identityProvider: "google",
    claims: [{ typ: "name", val: "User" }],
  })).toString("base64");
  await assert.rejects(
    getAuthenticatedUser(new Request("http://localhost", {
      headers: { "x-ms-client-principal": missingEmail },
    })),
    (error: unknown) => error instanceof AuthError && /email claim/.test(error.message),
  );
  const invalidEmail = Buffer.from(JSON.stringify({
    userId: "user-1",
    identityProvider: "google",
    claims: [
      { typ: "email", val: "not-an-email" },
      { typ: "name", val: "User" },
    ],
  })).toString("base64");
  await assert.rejects(
    getAuthenticatedUser(new Request("http://localhost", {
      headers: { "x-ms-client-principal": invalidEmail },
    })),
    (error: unknown) => error instanceof AuthError && /email claim/.test(error.message),
  );
  if (previous.auth === undefined) delete env.LEDGERLINES_AUTH_MODE;
  else env.LEDGERLINES_AUTH_MODE = previous.auth;
  if (previous.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous.nodeEnv;
  resetConfigForTests();
});

test("user profile upsert normalizes email and preserves settings", async () => {
  const repository = new LocalRepository();
  const user: AuthenticatedUser = {
    id: `google:user_profile_test_${Date.now()}`,
    roles: [],
    plan: "free",
    provider: "google",
    email: "User@Example.COM",
    displayName: "User One",
    emailVerified: true,
    isDevelopmentFallback: false,
  };
  const first = await repository.upsertUser(createUserProfile(user));
  const changed = await repository.upsertUser({
    ...first,
    settings: { ...first.settings, dailyPracticeMinutes: 45 },
    email: "New@Example.COM",
    normalizedEmail: normalizeEmail("New@Example.COM"),
    displayName: "User Renamed",
  });
  assert.equal(changed.normalizedEmail, "new@example.com");
  assert.equal(changed.settings.dailyPracticeMinutes, 45);
  assert.ok(changed.providerSyncedAt >= first.providerSyncedAt);
  const record = await repository.getUserRecord(user.id);
  assert.equal(record?.document.displayName, "User Renamed");
  assert.ok(record?.etag);
  await assert.rejects(
    repository.upsertUserRecord({ ...changed, displayName: "Concurrent" }, { ifMatch: "stale" }),
    (error: unknown) => error instanceof RepositoryConflictError,
  );
});

test("account context defaults to individual ownership and preserves own-data writes", () => {
  const user: AuthenticatedUser = {
    id: "account-user",
    roles: [],
    plan: "free",
    provider: "google",
    email: "account@example.com",
    displayName: "Account User",
    emailVerified: true,
    isDevelopmentFallback: false,
  };
  const context = buildAccountContext(user, createUserProfile(user), [], []);
  assert.equal(context.mode, "individual");
  assert.equal(context.activeClassroom, null);
  assert.equal(context.entitlement.monthlyTakeLimit, 5);
  assert.equal(context.permissions.canWriteOwnData, true);
});

test("LocalRepository supports classroom and billing CRUD with deterministic memberships", async () => {
  const repository = new LocalRepository();
  const now = new Date().toISOString();
  const classroom: ClassroomDoc = {
    id: `classroom_test_${Date.now()}`,
    type: "classroom",
    name: "Test Classroom",
    ownerUserId: "owner-test",
    teacherLimit: 5,
    billableStudentCount: 0,
    billing: {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: "none",
    },
    appStatus: "provisioning",
    createdAt: now,
    updatedAt: now,
  };
  await repository.createClassroom(classroom);
  const member: ClassroomMemberDoc = {
    id: classroomMemberId(classroom.id, "owner-test"),
    type: "classroom-member",
    classroomId: classroom.id,
    userId: "owner-test",
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await repository.createClassroomMember(member);
  assert.equal((await repository.getClassroomMember(classroom.id, "owner-test"))?.id, member.id);
  assert.equal((await repository.listClassroomMembers(classroom.id)).length, 1);
  const invitation: ClassroomInvitationDoc = {
    id: "invite-test",
    type: "classroom-invitation",
    classroomId: classroom.id,
    email: "student@example.com",
    normalizedEmail: "student@example.com",
    role: "student",
    status: "pending",
    tokenHash: null,
    expiresAt: null,
    createdByUserId: "owner-test",
    createdAt: now,
    updatedAt: now,
  };
  await repository.createClassroomInvitation(invitation);
  assert.equal((await repository.listClassroomInvitations(classroom.id)).length, 1);
  await repository.deleteClassroomInvitation(classroom.id, invitation.id);
  const billing: BillingEventDoc = {
    id: `evt_test_${Date.now()}`,
    type: "billing-event",
    provider: "stripe",
    eventType: "checkout.session.completed",
    livemode: false,
    payloadHash: "hash",
    processedAt: null,
    createdAt: now,
  };
  await repository.createBillingEvent(billing);
  assert.equal((await repository.getBillingEvent(billing.id))?.eventType, billing.eventType);
});

test("GET /api/account returns the authenticated personal context", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = {
    auth: env.LEDGERLINES_AUTH_MODE,
    nodeEnv: env.NODE_ENV,
    user: env.LEDGERLINES_DEV_USER_ID,
  };
  env.NODE_ENV = "development";
  env.LEDGERLINES_AUTH_MODE = "development";
  env.LEDGERLINES_DEV_USER_ID = `account_api_test_${Date.now()}`;
  resetConfigForTests();
  const response = await getAccount(new Request("http://localhost/api/account"));
  assert.equal(response.status, 200);
  const body = await response.json() as { account?: { mode?: string; profile?: { email?: string } } };
  assert.equal(body.account?.mode, "individual");
  assert.match(body.account?.profile?.email ?? "", /@local\.invalid$/);
  if (previous.auth === undefined) delete env.LEDGERLINES_AUTH_MODE;
  else env.LEDGERLINES_AUTH_MODE = previous.auth;
  if (previous.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previous.nodeEnv;
  if (previous.user === undefined) delete env.LEDGERLINES_DEV_USER_ID;
  else env.LEDGERLINES_DEV_USER_ID = previous.user;
  resetConfigForTests();
});
