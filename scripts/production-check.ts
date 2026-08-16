import assert from "node:assert/strict";
import Stripe from "stripe";
import fs from "node:fs/promises";
import test from "node:test";
import { coachReviewSchema, fallbackReview, type CoachInput } from "../src/lib/server/ai-coach";
import { redactTelemetry } from "../src/lib/server/observability";
import { assertTakeTransition } from "../src/lib/server/take-state";
import { getConfig, resetConfigForTests } from "../src/lib/server/config";
import { getStripeBillingConfig } from "../src/lib/server/stripe";
import {
  createClassroomCheckout,
  createClassroomBillingPortal,
  createDraftClassroom,
  mapStripeSubscriptionStatus,
  processStripeWebhook,
  setBillableStudentQuantity,
  syncClassroomFromSubscription,
} from "../src/lib/server/billing";
import type { StripeGateway } from "../src/lib/server/stripe";
import { BillingInProgressError } from "../src/lib/server/http";
import { AuthError, getAuthenticatedUser, type AuthenticatedUser } from "../src/lib/server/auth";
import {
  buildAccountContext,
  createUserProfile,
  getAccountContextForLayout,
  normalizeEmail,
  upsertAuthenticatedUserProfile,
} from "../src/lib/server/account";
import { GET as getAccount } from "../src/app/api/account/route";
import {
  LocalRepository,
  RepositoryConflictError,
  type RepositoryWriteOptions,
} from "../src/lib/server/repository";
import { classroomMemberId } from "../src/lib/server/ids";
import {
  cosmosWriteMode,
  isCosmosConditionalConflict,
} from "../src/lib/server/cosmos-repository";
import { userDocPath } from "../src/lib/server/paths";
import type {
  BillingEventDoc,
  ClassroomDoc,
  ClassroomInvitationDoc,
  ClassroomMemberDoc,
  UserProfileDoc,
} from "../src/lib/server/types";

class FakeBillingGateway implements StripeGateway {
  event: Stripe.Event;
  subscriptions: Stripe.Subscription[];
  checkoutSessionCount = 0;
  portalSessionCount = 0;
  createdItemCount = 0;
  deletedItemIds: string[] = [];
  retrieveGate: Promise<void> | null = null;
  failRetrieveAfterFirst = false;
  retrieveCount = 0;
  failDeleteCount = 0;

  constructor(event: Stripe.Event, subscriptions: Stripe.Subscription[] = []) {
    this.event = event;
    this.subscriptions = subscriptions;
  }

  async createCustomer(): Promise<Stripe.Customer> {
    return { id: `cus_test_${Date.now()}` } as Stripe.Customer;
  }

  async createCheckoutSession(): Promise<Stripe.Checkout.Session> {
    this.checkoutSessionCount += 1;
    return {
      id: `cs_test_${this.checkoutSessionCount}`,
      url: `https://checkout.test/${this.checkoutSessionCount}`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    } as Stripe.Checkout.Session;
  }

  async createBillingPortalSession(): Promise<Stripe.BillingPortal.Session> {
    this.portalSessionCount += 1;
    return {
      id: `bps_test_${this.portalSessionCount}`,
      url: `https://billing.test/session/${this.portalSessionCount}`,
    } as Stripe.BillingPortal.Session;
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    if (this.retrieveGate) await this.retrieveGate;
    this.retrieveCount += 1;
    if (this.failRetrieveAfterFirst && this.retrieveCount > 1) {
      throw new Error("simulated post-mutation retrieve failure");
    }
    const subscription = this.subscriptions.find((item) => item.id === subscriptionId);
    if (!subscription) throw new Error(`missing test subscription ${subscriptionId}`);
    return subscription;
  }

  async listCustomerSubscriptions(): Promise<Stripe.Subscription[]> {
    return this.subscriptions;
  }

  async createSubscriptionItem(params: Stripe.SubscriptionItemCreateParams): Promise<Stripe.SubscriptionItem> {
    this.createdItemCount += 1;
    const subscription = this.subscriptions.find((item) => item.id === params.subscription);
    if (!subscription) throw new Error("missing test subscription");
    const template = subscription.items.data[0];
    const item = {
      ...template,
      id: `si_test_${subscription.items.data.length + 1}`,
      price: testPrice(params.price ?? "price_student"),
      quantity: params.quantity ?? 1,
    };
    subscription.items.data.push(item);
    return item;
  }

  async updateSubscriptionItem(itemId: string, params: Stripe.SubscriptionItemUpdateParams): Promise<Stripe.SubscriptionItem> {
    for (const subscription of this.subscriptions) {
      const item = subscription.items.data.find((candidate) => candidate.id === itemId);
      if (item) {
        item.quantity = params.quantity ?? item.quantity;
        return item;
      }
    }
    throw new Error("missing test subscription item");
  }

  async deleteSubscriptionItem(itemId: string): Promise<Stripe.DeletedSubscriptionItem> {
    if (this.failDeleteCount > 0) {
      this.failDeleteCount -= 1;
      throw new Error("simulated duplicate item deletion failure");
    }
    this.deletedItemIds.push(itemId);
    for (const subscription of this.subscriptions) {
      subscription.items.data = subscription.items.data.filter((item) => item.id !== itemId);
    }
    return { id: itemId, deleted: true } as Stripe.DeletedSubscriptionItem;
  }

  constructWebhookEvent(): Stripe.Event {
    return this.event;
  }
}

function testPrice(id: string): Stripe.Price {
  return {
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: 1,
    currency: "usd",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: "prod_test",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
      meter: null,
      trial_period_days: null,
    },
    tax_behavior: null,
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: 100,
    unit_amount_decimal: null,
  };
}

function testSubscription(
  id: string,
  created: number,
  status: Stripe.Subscription.Status,
  studentQuantities: number[],
  classroomId: string,
): Stripe.Subscription {
  // @ts-expect-error Test fixture only supplies fields consumed by billing reconciliation.
  return {
    id,
    created,
    status,
    customer: "cus_test",
    metadata: { classroomId },
    items: {
      data: [
        {
          id: `${id}_base`,
          price: { id: "price_base" },
          quantity: 1,
          current_period_start: 1,
          current_period_end: 2,
        },
        ...studentQuantities.map((quantity, index) => ({
          id: `${id}_student_${index}`,
          price: { id: "price_student" },
          quantity,
          current_period_start: 1,
          current_period_end: 2,
        })),
      ],
    },
  } as Stripe.Subscription;
}

function testStripeEnvironment(): () => void {
  const env = process.env as Record<string, string | undefined>;
  const names = {
    secret: "STRIPE_SECRET_KEY",
    webhook: "STRIPE_WEBHOOK_SECRET",
    base: "STRIPE_CLASSROOM_BASE_PRICE_ID",
    student: "STRIPE_CLASSROOM_STUDENT_PRICE_ID",
    app: "LEDGERLINES_APP_BASE_URL",
  };
  const previous = Object.fromEntries(Object.values(names).map((name) => [name, env[name]]));
  env[names.secret] = "sk_test";
  env[names.webhook] = "whsec_test";
  env[names.base] = "price_base";
  env[names.student] = "price_student";
  env[names.app] = "http://localhost:3000";
  resetConfigForTests();
  return () => {
    for (const name of Object.values(names)) {
      if (previous[name] === undefined) delete env[name];
      else env[name] = previous[name];
    }
    resetConfigForTests();
  };
}

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

test("score queue name defaults to score-jobs and is overridable", () => {
  const previous = process.env.AZURE_SCORE_QUEUE;
  delete process.env.AZURE_SCORE_QUEUE;
  resetConfigForTests();
  assert.equal(getConfig().scoreQueueName, "score-jobs");

  process.env.AZURE_SCORE_QUEUE = "score-jobs-test";
  resetConfigForTests();
  assert.equal(getConfig().scoreQueueName, "score-jobs-test");

  if (previous === undefined) delete process.env.AZURE_SCORE_QUEUE;
  else process.env.AZURE_SCORE_QUEUE = previous;
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

test("layout account boundary handles only authentication failures", async () => {
  assert.equal(
    await getAccountContextForLayout(async () => {
      throw new AuthError();
    }),
    null,
  );
  await assert.rejects(
    getAccountContextForLayout(async () => {
      throw new Error("database unavailable");
    }),
    /database unavailable/,
  );
});

test("profile synchronization preserves concurrent settings and classroom refs", async () => {
  class MembershipRaceRepository extends LocalRepository {
    private injectConcurrentUpdate = false;
    private injected = false;

    armConcurrentUpdate(): void {
      this.injectConcurrentUpdate = true;
    }

    override async upsertUserRecord(
      user: UserProfileDoc,
      options?: RepositoryWriteOptions,
    ) {
      if (this.injectConcurrentUpdate && !this.injected) {
        this.injected = true;
        const latest = await super.getUserRecord(user.id);
        assert.ok(latest?.etag);
        await super.upsertUserRecord(
          {
            ...latest.document,
            settings: { ...latest.document.settings, dailyPracticeMinutes: 50 },
            classroomRefs: [
              { classroomId: "classroom-race", role: "teacher", status: "active" },
            ],
          },
          { ifMatch: latest.etag },
        );
      }
      return super.upsertUserRecord(user, options);
    }
  }

  const repository = new MembershipRaceRepository();
  const user: AuthenticatedUser = {
    id: `google:profile_race_test_${Date.now()}`,
    roles: [],
    plan: "free",
    provider: "google",
    email: "profile-race@example.com",
    displayName: "Profile Race User",
    emailVerified: true,
    isDevelopmentFallback: false,
  };
  await repository.upsertUser(createUserProfile(user));
  repository.armConcurrentUpdate();
  const synced = await upsertAuthenticatedUserProfile(
    { ...user, email: "updated-profile-race@example.com", displayName: "Updated Profile Race User" },
    repository,
  );
  assert.equal(synced.email, "updated-profile-race@example.com");
  assert.equal(synced.displayName, "Updated Profile Race User");
  assert.equal(synced.settings.dailyPracticeMinutes, 50);
  assert.deepEqual(synced.classroomRefs, [
    { classroomId: "classroom-race", role: "teacher", status: "active" },
  ]);
});

test("LocalRepository compare-and-swap rejects one of two concurrent writers", async () => {
  const repository = new LocalRepository();
  const user: AuthenticatedUser = {
    id: `google:cas_test_${Date.now()}`,
    roles: [],
    plan: "free",
    provider: "google",
    email: "cas@example.com",
    displayName: "CAS User",
    emailVerified: true,
    isDevelopmentFallback: false,
  };
  const original = await repository.upsertUser(createUserProfile(user));
  const [left, right] = await Promise.allSettled([
    repository.upsertUserRecord(
      { ...original, displayName: "Writer A" },
      { ifMatch: (await repository.getUserRecord(user.id))!.etag! },
    ),
    repository.upsertUserRecord(
      { ...original, displayName: "Writer B" },
      { ifMatch: (await repository.getUserRecord(user.id))!.etag! },
    ),
  ]);
  assert.equal([left, right].filter((result) => result.status === "fulfilled").length, 1);
  assert.equal([left, right].filter((result) =>
    result.status === "rejected" && result.reason instanceof RepositoryConflictError,
  ).length, 1);
  const final = await repository.getUser(user.id);
  assert.ok(final?.displayName === "Writer A" || final?.displayName === "Writer B");

  const createOnlyUser: AuthenticatedUser = { ...user, id: `${user.id}:create-only` };
  const createOnlyProfile = createUserProfile(createOnlyUser);
  const [createLeft, createRight] = await Promise.allSettled([
    repository.upsertUserRecord(createOnlyProfile, { ifNoneMatch: true }),
    repository.upsertUserRecord(createOnlyProfile, { ifNoneMatch: true }),
  ]);
  assert.equal(
    [createLeft, createRight].filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    [createLeft, createRight].filter((result) =>
      result.status === "rejected" && result.reason instanceof RepositoryConflictError,
    ).length,
    1,
  );
});

test("Cosmos conditional writes select atomic create or replace operations", () => {
  assert.equal(cosmosWriteMode({ ifNoneMatch: true }), "create");
  assert.equal(cosmosWriteMode({ ifMatch: "etag" }), "replace");
  assert.equal(cosmosWriteMode(), "upsert");
  assert.equal(isCosmosConditionalConflict({ code: 404 }, "replace"), true);
  assert.equal(isCosmosConditionalConflict({ code: 404 }, "upsert"), false);
  assert.equal(isCosmosConditionalConflict({ code: 412 }, "replace"), true);
});

test("LocalRepository recovers a stale leased domain lock", async () => {
  const repository = new LocalRepository();
  const user: AuthenticatedUser = {
    id: `google:stale_lock_test_${Date.now()}`,
    roles: [],
    plan: "free",
    provider: "google",
    email: "stale-lock@example.com",
    displayName: "Stale Lock User",
    emailVerified: true,
    isDevelopmentFallback: false,
  };
  const profile = createUserProfile(user);
  await repository.upsertUser(profile);
  const lockPath = `${userDocPath(user.id)}.lock`;
  await fs.mkdir(lockPath);
  const staleAt = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, staleAt, staleAt);

  await repository.upsertUser({ ...profile, displayName: "Recovered User" });
  assert.equal((await repository.getUser(user.id))?.displayName, "Recovered User");
  await assert.rejects(fs.access(lockPath));
});

test("LocalRepository serializes invitation update and stale delete", async () => {
  const repository = new LocalRepository();
  const classroomId = `classroom_delete_test_${Date.now()}`;
  const invitation: ClassroomInvitationDoc = {
    id: "delete-race-invite",
    type: "classroom-invitation",
    classroomId,
    email: "delete-race@example.com",
    normalizedEmail: "delete-race@example.com",
    role: "student",
    status: "pending",
    tokenHash: null,
    expiresAt: null,
    createdByUserId: "owner-delete-race",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await repository.createClassroomInvitation(invitation);
  const initial = await repository.getClassroomInvitationRecord(classroomId, invitation.id);
  assert.ok(initial?.etag);
  const [updated, deleted] = await Promise.allSettled([
    repository.upsertClassroomInvitation(
      { ...invitation, status: "accepted" },
      { ifMatch: initial.etag },
    ),
    repository.deleteClassroomInvitation(classroomId, invitation.id, { ifMatch: initial.etag }),
  ]);
  assert.equal([updated, deleted].filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    [updated, deleted].filter((result) =>
      result.status === "rejected" && result.reason instanceof RepositoryConflictError,
    ).length,
    1,
  );
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

test("Stripe status mapping keeps trial grace and stops unpaid contracts", () => {
  assert.deepEqual(mapStripeSubscriptionStatus("active").access, "available");
  assert.deepEqual(mapStripeSubscriptionStatus("trialing").access, "available");
  assert.deepEqual(mapStripeSubscriptionStatus("past_due").access, "available");
  assert.deepEqual(mapStripeSubscriptionStatus("unpaid").access, "suspended");
  assert.deepEqual(mapStripeSubscriptionStatus("incomplete_expired").access, "suspended");
  assert.deepEqual(mapStripeSubscriptionStatus("future_status").access, "suspended");
});

test("Stripe billing configuration fails closed without server settings", () => {
  const env = process.env as Record<string, string | undefined>;
  const names = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_CLASSROOM_BASE_PRICE_ID",
    "STRIPE_CLASSROOM_STUDENT_PRICE_ID",
    "LEDGERLINES_APP_BASE_URL",
  ];
  const previous = new Map(names.map((name) => [name, env[name]]));
  for (const name of names) delete env[name];
  resetConfigForTests();
  assert.throws(() => getStripeBillingConfig(), /billing is not configured/);
  for (const name of names) {
    const value = previous.get(name);
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  resetConfigForTests();
});

test("Checkout idempotency is request-scoped and guarded by a classroom attempt lease", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const ownerId = `stripe_checkout_owner_${Date.now()}`;
    const classroom = await createDraftClassroom(ownerId, { name: "Checkout test" }, repository);
    const gateway = new FakeBillingGateway({} as Stripe.Event);
    const first = await createClassroomCheckout(classroom.id, ownerId, repository, gateway, "request-a");
    const retry = await createClassroomCheckout(classroom.id, ownerId, repository, gateway, "request-a");
    assert.deepEqual(retry, first);
    assert.equal(gateway.checkoutSessionCount, 1);
    await assert.rejects(
      createClassroomCheckout(classroom.id, ownerId, repository, gateway, "request-b"),
      BillingInProgressError,
    );
    const record = await repository.getClassroomRecord(classroom.id);
    if (!record?.etag || !record.document.billing.checkoutAttempt) throw new Error("missing checkout record");
    await repository.upsertClassroom(
      {
        ...record.document,
        billing: {
          ...record.document.billing,
          checkoutAttempt: {
            ...record.document.billing.checkoutAttempt,
            status: "expired",
          },
        },
      },
      { ifMatch: record.etag },
    );
    await createClassroomCheckout(classroom.id, ownerId, repository, gateway, "request-b");
    assert.equal(gateway.checkoutSessionCount, 2);
    const remoteRecord = await repository.getClassroomRecord(classroom.id);
    if (!remoteRecord?.etag || !remoteRecord.document.billing.stripeCustomerId) throw new Error("missing customer record");
    const remoteSubscription = testSubscription("sub_remote_checkout", 500, "active", [], classroom.id);
    remoteSubscription.customer = remoteRecord.document.billing.stripeCustomerId;
    gateway.subscriptions = [remoteSubscription];
    await repository.upsertClassroom(
      {
        ...remoteRecord.document,
        billing: {
          ...remoteRecord.document.billing,
          stripeSubscriptionId: null,
          status: "none",
          stripeStatus: null,
          checkoutAttempt: {
            ...remoteRecord.document.billing.checkoutAttempt!,
            status: "expired",
          },
        },
      },
      { ifMatch: remoteRecord.etag },
    );
    await assert.rejects(
      createClassroomCheckout(classroom.id, ownerId, repository, gateway, "request-c"),
      /classroom already has a contract/,
    );
    assert.equal(gateway.checkoutSessionCount, 2);
    const portalFirst = await createClassroomBillingPortal(classroom.id, ownerId, repository, gateway, "portal-a");
    const portalRetry = await createClassroomBillingPortal(classroom.id, ownerId, repository, gateway, "portal-a");
    assert.deepEqual(portalRetry, portalFirst);
    assert.equal(gateway.portalSessionCount, 1);
    const portalRecord = await repository.getClassroomRecord(classroom.id);
    if (!portalRecord?.etag || !portalRecord.document.billing.portalAttempt) throw new Error("missing portal record");
    await repository.upsertClassroom(
      {
        ...portalRecord.document,
        billing: {
          ...portalRecord.document.billing,
          portalAttempt: {
            ...portalRecord.document.billing.portalAttempt,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          },
        },
      },
      { ifMatch: portalRecord.etag },
    );
    await createClassroomBillingPortal(classroom.id, ownerId, repository, gateway, "portal-a");
    assert.equal(gateway.portalSessionCount, 2);
  } finally {
    restore();
  }
});

test("Billing event leases reject active delivery, reclaim stale delivery, and dedupe only processed events", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const eventId = `evt_lease_${Date.now()}`;
    const now = new Date();
    const event: BillingEventDoc = {
      id: eventId,
      type: "billing-event",
      provider: "stripe",
      eventType: "test.unknown",
      livemode: false,
      payloadHash: "hash",
      processedAt: null,
      createdAt: now.toISOString(),
      status: "processing",
      attemptCount: 1,
      processingOwnerToken: "other-owner",
      processingStartedAt: now.toISOString(),
      processingExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    await repository.createBillingEvent(event);
    // @ts-expect-error Test webhook fixture only supplies fields consumed by the gateway seam.
    const stripeEvent = {
      id: eventId,
      object: "event",
      created: Math.floor(now.getTime() / 1000),
      livemode: false,
      type: "test.unknown",
      data: { object: {} },
    } as Stripe.Event;
    const gateway = new FakeBillingGateway(stripeEvent);
    await assert.rejects(
      processStripeWebhook("{}", "sig", repository, gateway),
      BillingInProgressError,
    );
    const record = await repository.getBillingEventRecord(eventId);
    if (!record?.etag) throw new Error("missing event record");
    await repository.upsertBillingEvent(
      {
        ...event,
        processingExpiresAt: new Date(now.getTime() - 1_000).toISOString(),
      },
      { ifMatch: record.etag },
    );
    const processed = await processStripeWebhook("{}", "sig", repository, gateway);
    assert.equal(processed.status, "ignored");
    assert.equal((await repository.getBillingEvent(eventId))?.status, "processed");
    const duplicate = await processStripeWebhook("{}", "sig", repository, gateway);
    assert.equal(duplicate.status, "duplicate");
  } finally {
    restore();
  }
});

test("Webhook reconciliation selects the newest metadata and base-price subscription", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const classroomId = `classroom_order_${Date.now()}`;
    const now = new Date().toISOString();
    await repository.createClassroom({
      id: classroomId,
      type: "classroom",
      name: "Order test",
      ownerUserId: "owner-order",
      teacherLimit: 10,
      billableStudentCount: 0,
      billing: {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_old",
        status: "active",
      },
      appStatus: "active",
      createdAt: now,
      updatedAt: now,
    });
    const oldSubscription = testSubscription("sub_old", 100, "canceled", [], classroomId);
    const newSubscription = testSubscription("sub_new", 200, "active", [2], classroomId);
    const event = {
      id: `evt_order_${Date.now()}`,
      object: "event",
      created: 300,
      livemode: false,
      type: "customer.subscription.deleted",
      data: { object: oldSubscription },
    } as Stripe.Event;
    const gateway = new FakeBillingGateway(event, [oldSubscription, newSubscription]);
    await processStripeWebhook("{}", "sig", repository, gateway);
    const updated = await repository.getClassroom(classroomId);
    assert.equal(updated?.billing.stripeSubscriptionId, "sub_new");
    assert.equal(updated?.billing.status, "active");
    assert.equal(updated?.billableStudentCount, 2);
  } finally {
    restore();
  }
});

test("Same-second subscription selection prefers usable status then deterministic identity", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const classroomId = `classroom_same_second_${Date.now()}`;
    const now = new Date().toISOString();
    await repository.createClassroom({
      id: classroomId,
      type: "classroom",
      name: "Same second test",
      ownerUserId: "owner-same-second",
      teacherLimit: 10,
      billableStudentCount: 0,
      billing: {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_a",
        status: "canceled",
      },
      appStatus: "suspended",
      createdAt: now,
      updatedAt: now,
    });
    const oldCanceled = testSubscription("sub_a", 500, "canceled", [], classroomId);
    const activeB = testSubscription("sub_b", 500, "active", [1], classroomId);
    const activeC = testSubscription("sub_c", 500, "active", [2], classroomId);
    const gateway = new FakeBillingGateway({
      id: `evt_same_second_${Date.now()}`,
      object: "event",
      created: 600,
      livemode: false,
      type: "customer.subscription.deleted",
      data: { object: oldCanceled },
    } as Stripe.Event, [activeB, oldCanceled, activeC]);
    await processStripeWebhook("{}", "sig", repository, gateway);
    const updated = await repository.getClassroom(classroomId);
    assert.equal(updated?.billing.stripeSubscriptionId, "sub_c");
    assert.equal(updated?.billableStudentCount, 2);
    assert.equal(updated?.billing.stripeSubscriptionSelectionKey?.endsWith(":sub_c"), true);
  } finally {
    restore();
  }
});

test("CAS retry ignores an old subscription after a newer contract is saved", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const classroomId = `classroom_cas_order_${Date.now()}`;
    const now = new Date().toISOString();
    await repository.createClassroom({
      id: classroomId,
      type: "classroom",
      name: "CAS order test",
      ownerUserId: "owner-cas",
      teacherLimit: 10,
      billableStudentCount: 0,
      billing: {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_old_cas",
        stripeSubscriptionCreatedAt: 100,
        status: "active",
      },
      appStatus: "active",
      createdAt: now,
      updatedAt: now,
    });
    const oldSubscription = testSubscription("sub_old_cas", 100, "canceled", [], classroomId);
    const originalUpsert = repository.upsertClassroom.bind(repository);
    let injected = false;
    repository.upsertClassroom = async (document, options) => {
      if (!injected && document.billing.stripeSubscriptionId === "sub_old_cas") {
        injected = true;
        const current = await repository.getClassroomRecord(classroomId);
        if (!current?.etag) throw new Error("missing CAS record");
        await originalUpsert(
          {
            ...current.document,
            billing: {
              ...current.document.billing,
              stripeSubscriptionId: "sub_new_cas",
              stripeSubscriptionCreatedAt: 100,
              status: "active",
              stripeStatus: "active",
            },
          },
          { ifMatch: current.etag },
        );
        throw new RepositoryConflictError("simulated concurrent contract write");
      }
      return originalUpsert(document, options);
    };
    await syncClassroomFromSubscription(classroomId, oldSubscription, repository);
    const current = await repository.getClassroom(classroomId);
    assert.equal(current?.billing.stripeSubscriptionId, "sub_new_cas");
    assert.equal(current?.billing.status, "active");
  } finally {
    restore();
  }
});

test("Inactive duplicate student items block pending operations until re-contract reconciliation", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const classroomId = `classroom_inactive_quantity_${Date.now()}`;
    const now = new Date().toISOString();
    await repository.createClassroom({
      id: classroomId,
      type: "classroom",
      name: "Inactive quantity test",
      ownerUserId: "owner-inactive",
      teacherLimit: 10,
      billableStudentCount: 1,
      billing: {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_inactive",
        status: "active",
        studentQuantityOperation: {
          operationVersion: "pending-inactive",
          ownerToken: "pending-owner",
          targetQuantity: 2,
          status: "pending",
          startedAt: now,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      appStatus: "active",
      createdAt: now,
      updatedAt: now,
    });
    const inactive = testSubscription("sub_inactive", 100, "canceled", [1, 1], classroomId);
    const gateway = new FakeBillingGateway({
      id: `evt_inactive_${Date.now()}`,
      object: "event",
      created: 200,
      livemode: false,
      type: "customer.subscription.deleted",
      data: { object: inactive },
    } as Stripe.Event, [inactive]);
    await processStripeWebhook("{}", "sig", repository, gateway);
    assert.equal(
      (await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status,
      "blocked_inactive",
    );
    assert.equal(inactive.items.data.filter((item) => item.id.includes("_student_")).length, 2);

    const active = testSubscription("sub_recontract", 300, "active", [2], classroomId);
    gateway.subscriptions = [active];
    gateway.event = {
      id: `evt_recontract_${Date.now()}`,
      object: "event",
      created: 400,
      livemode: false,
      type: "customer.subscription.updated",
      data: { object: active },
    } as Stripe.Event;
    await processStripeWebhook("{}", "sig", repository, gateway);
    const reconciled = await repository.getClassroom(classroomId);
    assert.equal(reconciled?.billing.stripeSubscriptionId, "sub_recontract");
    assert.equal(reconciled?.billableStudentCount, 2);
    assert.equal(reconciled?.billing.studentQuantityOperation?.status, "completed");
  } finally {
    restore();
  }
});

test("Student quantity lease canonicalizes duplicate price items and reclaims stale leases", async () => {
  const restore = testStripeEnvironment();
  try {
    const repository = new LocalRepository();
    const classroomId = `classroom_quantity_${Date.now()}`;
    const now = new Date().toISOString();
    await repository.createClassroom({
      id: classroomId,
      type: "classroom",
      name: "Quantity test",
      ownerUserId: "owner-quantity",
      teacherLimit: 10,
      billableStudentCount: 0,
      billing: {
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_quantity",
        status: "active",
        stripeStudentSubscriptionItemId: `${"sub_quantity"}_student_0`,
        studentQuantityOperation: {
          operationVersion: "old",
          ownerToken: "stale-owner",
          targetQuantity: 1,
          status: "pending",
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      },
      appStatus: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subscription = testSubscription("sub_quantity", 200, "active", [1, 1], classroomId);
    const gateway = new FakeBillingGateway({} as Stripe.Event, [subscription]);
    const updated = await setBillableStudentQuantity(
      { classroomId, quantity: 3, operationVersion: "new-operation" },
      repository,
      gateway,
    );
    assert.equal(updated.billableStudentCount, 3);
    assert.equal(gateway.createdItemCount, 0);
    assert.equal(subscription.items.data.filter((item) => item.id.includes("_student_")).length, 1);
    assert.equal(subscription.items.data.find((item) => item.id === "sub_quantity_student_0")?.quantity, 3);
    assert.equal(gateway.deletedItemIds.length, 1);
    assert.equal((await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status, "completed");
    gateway.retrieveCount = 0;
    gateway.failRetrieveAfterFirst = true;
    await assert.rejects(
      setBillableStudentQuantity(
        { classroomId, quantity: 4, operationVersion: "post-mutation-retry" },
        repository,
        gateway,
      ),
      /simulated post-mutation retrieve failure/,
    );
    assert.equal(
      (await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status,
      "pending_reconciliation",
    );
    gateway.failRetrieveAfterFirst = false;
    gateway.event = {
      id: `evt_quantity_reconcile_${Date.now()}`,
      object: "event",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: "customer.subscription.updated",
      data: { object: subscription },
    } as Stripe.Event;
    await processStripeWebhook("{}", "sig", repository, gateway);
    assert.equal((await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status, "completed");
    const reconciled = await setBillableStudentQuantity(
      { classroomId, quantity: 4, operationVersion: "post-mutation-retry" },
      repository,
      gateway,
    );
    assert.equal(reconciled.billableStudentCount, 4);
    assert.equal((await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status, "completed");
    const canonicalItem = subscription.items.data.find((item) => item.id === "sub_quantity_student_0");
    if (!canonicalItem) throw new Error("missing canonical student item");
    subscription.items.data.push({ ...canonicalItem, id: "sub_quantity_student_extra", quantity: 1 });
    gateway.failDeleteCount = 1;
    await assert.rejects(
      setBillableStudentQuantity(
        { classroomId, quantity: 4, operationVersion: "delete-retry" },
        repository,
        gateway,
      ),
      /simulated duplicate item deletion failure/,
    );
    assert.equal(
      (await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status,
      "pending_reconciliation",
    );
    gateway.failDeleteCount = 0;
    await setBillableStudentQuantity(
      { classroomId, quantity: 4, operationVersion: "delete-retry" },
      repository,
      gateway,
    );
    assert.equal(subscription.items.data.filter((item) => item.id.includes("_student_")).length, 1);
    assert.equal((await repository.getClassroom(classroomId))?.billing.studentQuantityOperation?.status, "completed");

    let releaseRetrieve: () => void = () => {};
    gateway.retrieveGate = new Promise<void>((resolve) => {
      releaseRetrieve = resolve;
    });
    const first = setBillableStudentQuantity(
      { classroomId, quantity: 4, operationVersion: "concurrent-a" },
      repository,
      gateway,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(
      setBillableStudentQuantity(
        { classroomId, quantity: 5, operationVersion: "concurrent-b" },
        repository,
        gateway,
      ),
      BillingInProgressError,
    );
    releaseRetrieve();
    await first;
  } finally {
    restore();
  }
});
