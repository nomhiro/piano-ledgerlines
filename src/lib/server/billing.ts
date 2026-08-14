import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  ConfigurationError,
  BillingInProgressError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./http";
import {
  getRepository,
  RepositoryConflictError,
  type Repository,
  type RepositoryDocument,
} from "./repository";
import { classroomMemberId, newClassroomId } from "./ids";
import type {
  BillingEventDoc,
  BillingOperationLeaseDoc,
  ClassroomContractStatus,
  ClassroomDoc,
  ClassroomMemberDoc,
  CheckoutAttemptDoc,
  PortalAttemptDoc,
} from "./types";
import {
  buildBillingUrl,
  getStripeBillingConfig,
  getStripeGateway,
  type StripeGateway,
} from "./stripe";

export type ClassroomBillingAccess = "available" | "suspended";

export interface StripeStatusMapping {
  contractStatus: ClassroomContractStatus;
  appStatus: ClassroomDoc["appStatus"];
  access: ClassroomBillingAccess;
}

export function mapStripeSubscriptionStatus(status: string): StripeStatusMapping {
  switch (status) {
    case "active":
    case "trialing":
      return { contractStatus: "active", appStatus: "active", access: "available" };
    case "past_due":
      return { contractStatus: "past_due", appStatus: "active", access: "available" };
    case "incomplete":
      return { contractStatus: "incomplete", appStatus: "suspended", access: "suspended" };
    case "unpaid":
    case "canceled":
    case "incomplete_expired":
    case "paused":
    default:
      return { contractStatus: "canceled", appStatus: "suspended", access: "suspended" };
  }
}

export function stripeSubscriptionStatusPriority(status: string): number {
  if (status === "active" || status === "trialing" || status === "past_due") return 2;
  if (status === "incomplete") return 1;
  return 0;
}

export function stripeSubscriptionSelectionKey(subscription: Stripe.Subscription): string {
  return [
    subscription.created.toString().padStart(12, "0"),
    stripeSubscriptionStatusPriority(subscription.status).toString(),
    subscription.id,
  ].join(":");
}

export function compareStripeSubscriptionSelection(
  left: Stripe.Subscription,
  right: Stripe.Subscription,
): number {
  const leftKey = stripeSubscriptionSelectionKey(left);
  const rightKey = stripeSubscriptionSelectionKey(right);
  return leftKey === rightKey ? 0 : leftKey > rightKey ? 1 : -1;
}

function storedSubscriptionSelectionKey(classroom: ClassroomDoc): string | null {
  if (classroom.billing.stripeSubscriptionSelectionKey) {
    return classroom.billing.stripeSubscriptionSelectionKey;
  }
  if (
    !classroom.billing.stripeSubscriptionId ||
    classroom.billing.stripeSubscriptionCreatedAt === null ||
    classroom.billing.stripeSubscriptionCreatedAt === undefined
  ) {
    return null;
  }
  return [
    classroom.billing.stripeSubscriptionCreatedAt.toString().padStart(12, "0"),
    stripeSubscriptionStatusPriority(classroom.billing.stripeStatus ?? "").toString(),
    classroom.billing.stripeSubscriptionId,
  ].join(":");
}

export function classroomHasPaidEntitlement(status: ClassroomContractStatus): boolean {
  return status === "active" || status === "past_due";
}

function classroomHasUnresolvedStripeContract(classroom: ClassroomDoc): boolean {
  if (!classroom.billing.stripeSubscriptionId) return false;
  if (classroom.billing.status === "canceled" && !classroom.billing.stripeStatus) return false;
  return !["canceled", "incomplete_expired"].includes(classroom.billing.stripeStatus ?? "");
}

export interface CreateDraftClassroomInput {
  name: string;
}

export async function createDraftClassroom(
  ownerUserId: string,
  input: CreateDraftClassroomInput,
  repository: Repository = getRepository(),
  now = new Date().toISOString(),
): Promise<ClassroomDoc> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ValidationError("classroom name must be 1-120 characters");
  const owned = await repository.listClassroomsByOwner(ownerUserId);
  if (owned.some((classroom) => classroom.billing.stripeSubscriptionId || classroomHasPaidEntitlement(classroom.billing.status))) {
    throw new ValidationError("owner already has a classroom contract");
  }

  const classroom: ClassroomDoc = {
    id: newClassroomId(),
    type: "classroom",
    name,
    ownerUserId,
    teacherLimit: 5,
    reservedTeacherSeatCount: 0,
    teacherSeatVersion: 0,
    invitationRateLimits: {},
    billableStudentCount: 0,
    billing: {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: "none",
      stripeStatus: null,
      stripeBaseSubscriptionItemId: null,
      stripeStudentSubscriptionItemId: null,
      stripeCurrentPeriodStart: null,
      stripeCurrentPeriodEnd: null,
      billingVersion: 0,
    },
    appStatus: "provisioning",
    createdAt: now,
    updatedAt: now,
  };
  await repository.createClassroom(classroom, { ifNoneMatch: true });
  const ownerMember: ClassroomMemberDoc = {
    id: classroomMemberId(classroom.id, ownerUserId),
    type: "classroom-member",
    classroomId: classroom.id,
    userId: ownerUserId,
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await repository.createClassroomMember(ownerMember, { ifNoneMatch: true });
  return classroom;
}

async function requireOwner(
  classroomId: string,
  userId: string,
  repository: Repository,
): Promise<ClassroomDoc> {
  const classroom = await repository.getClassroom(classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  const member = await repository.getClassroomMember(classroomId, userId);
  if (classroom.ownerUserId !== userId || member?.role !== "owner" || member.status !== "active") {
    throw new ForbiddenError();
  }
  return classroom;
}

async function updateClassroomWithCas(
  classroomId: string,
  update: (classroom: ClassroomDoc) => ClassroomDoc,
  repository: Repository,
): Promise<ClassroomDoc> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("billing repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current: RepositoryDocument<ClassroomDoc> | null = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("billing repository returned no etag");
    try {
      return await repository.upsertClassroom(update(current.document), { ifMatch: current.etag });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("classroom update retries exhausted");
}

function customerId(value: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof value === "string" ? value : value.id;
}

function subscriptionIdFromValue(value: string | Stripe.Subscription | null): string | null {
  return value ? (typeof value === "string" ? value : value.id) : null;
}

function operationKeyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkoutAttemptExpiry(now: Date): string {
  return new Date(now.getTime() + 30 * 60 * 1000).toISOString();
}

async function acquireCheckoutAttempt(
  classroomId: string,
  operationKey: string,
  repository: Repository,
): Promise<{ attempt: CheckoutAttemptDoc; reuse: boolean }> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("billing repository does not support compare-and-swap");
  }
  const keyHash = operationKeyHash(operationKey);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("billing repository returned no etag");
    const existing = current.document.billing.checkoutAttempt;
    const now = new Date();
    if (existing?.status === "completed") {
      throw new ValidationError("checkout has already completed; wait for billing synchronization");
    }
    if (existing?.status === "pending" && existing.expiresAt > now.toISOString()) {
      if (existing.operationKeyHash !== keyHash) throw new BillingInProgressError("checkout is already in progress");
      if (existing.sessionId && existing.sessionUrl) return { attempt: existing, reuse: true };
      throw new BillingInProgressError("checkout session is being created");
    }
    if (
      existing?.status === "pending" &&
      existing.operationKeyHash === keyHash &&
      !existing.sessionId
    ) {
      const reclaimed: CheckoutAttemptDoc = {
        ...existing,
        expiresAt: checkoutAttemptExpiry(now),
        createdAt: existing.createdAt,
      };
      try {
        await repository.upsertClassroom(
          {
            ...current.document,
            billing: { ...current.document.billing, checkoutAttempt: reclaimed },
            updatedAt: now.toISOString(),
          },
          { ifMatch: current.etag },
        );
        return { attempt: reclaimed, reuse: false };
      } catch (error) {
        if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
        continue;
      }
    }
    const next: CheckoutAttemptDoc = {
      operationKeyHash: keyHash,
      attemptId: randomUUID(),
      sessionId: null,
      sessionUrl: null,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: checkoutAttemptExpiry(now),
    };
    try {
      await repository.upsertClassroom(
        {
          ...current.document,
          billing: { ...current.document.billing, checkoutAttempt: next },
          updatedAt: now.toISOString(),
        },
        { ifMatch: current.etag },
      );
      return { attempt: next, reuse: false };
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("checkout attempt lease retries exhausted");
}

async function saveCheckoutSession(
  classroomId: string,
  attempt: CheckoutAttemptDoc,
  repository: Repository,
): Promise<CheckoutAttemptDoc> {
  const saved = await updateClassroomWithCas(
    classroomId,
    (current) => {
      const currentAttempt = current.billing.checkoutAttempt;
      if (
        !currentAttempt ||
        currentAttempt.attemptId !== attempt.attemptId ||
        currentAttempt.operationKeyHash !== attempt.operationKeyHash
      ) {
        throw new BillingInProgressError("checkout attempt was replaced");
      }
      return {
        ...current,
        billing: { ...current.billing, checkoutAttempt: attempt },
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
  return saved.billing.checkoutAttempt ?? attempt;
}

async function updateCheckoutAttemptStatus(
  classroomId: string,
  sessionId: string,
  status: "completed" | "expired",
  repository: Repository,
): Promise<void> {
  await updateClassroomWithCas(
    classroomId,
    (current) => {
      const attempt = current.billing.checkoutAttempt;
      if (!attempt || attempt.sessionId !== sessionId || attempt.status !== "pending") return current;
      return {
        ...current,
        billing: {
          ...current.billing,
          checkoutAttempt: { ...attempt, status },
        },
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
}

async function blockStudentQuantityOperationForInactiveContract(
  classroomId: string,
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("billing repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("billing repository returned no etag");
    const operation = current.document.billing.studentQuantityOperation;
    if (
      !operation ||
      !["pending", "pending_reconciliation"].includes(operation.status)
    ) {
      return;
    }
    try {
      await repository.upsertClassroom(
        {
          ...current.document,
          billing: {
            ...current.document.billing,
            studentQuantityOperation: {
              ...operation,
              status: "blocked_inactive",
              completedAt: null,
              lastError: "student quantity sync is blocked while the contract is inactive",
            },
          },
          updatedAt: new Date().toISOString(),
        },
        { ifMatch: current.etag },
      );
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("inactive student operation settlement retries exhausted");
}

async function acquirePortalAttempt(
  classroomId: string,
  operationKey: string,
  repository: Repository,
): Promise<{ attempt: PortalAttemptDoc; reuse: boolean }> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("billing repository does not support compare-and-swap");
  }
  const keyHash = operationKeyHash(operationKey);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("billing repository returned no etag");
    const existing = current.document.billing.portalAttempt;
    const now = new Date();
    if (existing && existing.expiresAt > now.toISOString() && existing.operationKeyHash === keyHash) {
      if (existing.sessionId && existing.sessionUrl) return { attempt: existing, reuse: true };
      throw new BillingInProgressError("billing portal session is being created");
    }
    const next: PortalAttemptDoc = {
      operationKeyHash: keyHash,
      attemptId: randomUUID(),
      sessionId: null,
      sessionUrl: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PORTAL_RETRY_WINDOW_MS).toISOString(),
    };
    try {
      await repository.upsertClassroom(
        {
          ...current.document,
          billing: { ...current.document.billing, portalAttempt: next },
          updatedAt: now.toISOString(),
        },
        { ifMatch: current.etag },
      );
      return { attempt: next, reuse: false };
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("billing portal attempt retries exhausted");
}

async function savePortalSession(
  classroomId: string,
  attempt: PortalAttemptDoc,
  repository: Repository,
): Promise<void> {
  await updateClassroomWithCas(
    classroomId,
    (current) => {
      const currentAttempt = current.billing.portalAttempt;
      if (
        !currentAttempt ||
        currentAttempt.attemptId !== attempt.attemptId ||
        currentAttempt.operationKeyHash !== attempt.operationKeyHash
      ) {
        throw new BillingInProgressError("billing portal attempt was replaced");
      }
      return {
        ...current,
        billing: { ...current.billing, portalAttempt: attempt },
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
}

export async function createClassroomCheckout(
  classroomId: string,
  userId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
  operationKey: string = randomUUID(),
): Promise<{ url: string; sessionId: string }> {
  let classroom = await requireOwner(classroomId, userId, repository);
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  if (classroom.billing.stripeCustomerId && !classroomHasPaidEntitlement(classroom.billing.status)) {
    await reconcileClassroomSubscription(classroomId, null, repository, stripeClient);
    classroom = await requireOwner(classroomId, userId, repository);
  }
  if (classroomHasUnresolvedStripeContract(classroom) || classroomHasPaidEntitlement(classroom.billing.status)) {
    throw new ValidationError("classroom already has a contract");
  }
  const checkout = await acquireCheckoutAttempt(classroomId, operationKey, repository);
  if (checkout.reuse) {
    return { url: checkout.attempt.sessionUrl!, sessionId: checkout.attempt.sessionId! };
  }
  let customer = classroom.billing.stripeCustomerId;
  if (!customer) {
    const owner = await repository.getUser(userId);
    const created = await stripeClient.createCustomer(
      {
        email: owner?.email,
        name: owner?.displayName,
        metadata: { classroomId, ownerUserId: userId },
      },
      { idempotencyKey: `classroom:${classroomId}:customer` },
    );
    customer = created.id;
    await updateClassroomWithCas(
      classroomId,
      (current) => ({
        ...current,
        billing: { ...current.billing, stripeCustomerId: customer },
        updatedAt: new Date().toISOString(),
      }),
      repository,
    );
  }

  const session = await stripeClient.createCheckoutSession(
    {
      mode: "subscription",
      customer,
      line_items: [{ price: config.classroomBasePriceId, quantity: 1 }],
      success_url: buildBillingUrl(config.appBaseUrl, "/billing/success", classroomId),
      cancel_url: buildBillingUrl(config.appBaseUrl, "/billing/cancel", classroomId),
      metadata: { classroomId },
      subscription_data: { metadata: { classroomId } },
    },
    { idempotencyKey: `classroom:${classroomId}:checkout:${checkout.attempt.attemptId}` },
  );
  if (!session.url) throw new Error("Stripe checkout session did not return a URL");
  const expiresAt = typeof session.expires_at === "number"
    ? new Date(session.expires_at * 1000).toISOString()
    : checkout.attempt.expiresAt;
  await saveCheckoutSession(
    classroomId,
    {
      ...checkout.attempt,
      sessionId: session.id,
      sessionUrl: session.url,
      expiresAt,
    },
    repository,
  );
  return { url: session.url, sessionId: session.id };
}

export async function createClassroomBillingPortal(
  classroomId: string,
  userId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
  operationKey: string = randomUUID(),
): Promise<{ url: string }> {
  const classroom = await requireOwner(classroomId, userId, repository);
  const customer = classroom.billing.stripeCustomerId;
  if (!customer) throw new ValidationError("classroom has no Stripe customer");
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  const portal = await acquirePortalAttempt(classroomId, operationKey, repository);
  if (portal.reuse) return { url: portal.attempt.sessionUrl! };
  const session = await stripeClient.createBillingPortalSession(
    {
      customer,
      return_url: buildBillingUrl(config.appBaseUrl, "/classrooms/billing", classroomId),
    },
    { idempotencyKey: `classroom:${classroomId}:portal:${portal.attempt.attemptId}` },
  );
  await savePortalSession(
    classroomId,
    {
      ...portal.attempt,
      sessionId: session.id,
      sessionUrl: session.url,
    },
    repository,
  );
  return { url: session.url };
}

function subscriptionItemPriceId(item: Stripe.SubscriptionItem): string {
  return typeof item.price === "string" ? item.price : item.price.id;
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return customerId(subscription.customer);
}

function hasClassroomBasePrice(subscription: Stripe.Subscription, basePriceId: string): boolean {
  return subscription.items.data.some((item) => subscriptionItemPriceId(item) === basePriceId);
}

function subscriptionPeriod(value: number | null | undefined): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

export async function syncClassroomFromSubscription(
  classroomId: string,
  subscription: Stripe.Subscription,
  repository: Repository = getRepository(),
): Promise<ClassroomDoc> {
  const config = getStripeBillingConfig();
  const currentClassroom = await repository.getClassroom(classroomId);
  if (!currentClassroom) throw new NotFoundError("classroom not found");
  if (
    subscription.metadata.classroomId !== classroomId ||
    (currentClassroom.billing.stripeCustomerId &&
      subscriptionCustomerId(subscription) !== currentClassroom.billing.stripeCustomerId)
  ) {
    throw new ValidationError("Stripe subscription metadata does not match classroom");
  }
  const mapping = mapStripeSubscriptionStatus(subscription.status);
  const baseItem = subscription.items.data.find((item) => subscriptionItemPriceId(item) === config.classroomBasePriceId);
  const studentItem = subscription.items.data.find((item) => subscriptionItemPriceId(item) === config.classroomStudentPriceId);
  if (!baseItem && mapping.access === "available") {
    throw new ValidationError("Stripe subscription is missing the classroom base price");
  }
  const customer = customerId(subscription.customer);
  const incomingSelectionKey = stripeSubscriptionSelectionKey(subscription);
  return updateClassroomWithCas(
    classroomId,
    (current) => {
      const differentIdentity =
        current.billing.stripeSubscriptionId !== null &&
        current.billing.stripeSubscriptionId !== subscription.id;
      const storedSelectionKey = storedSubscriptionSelectionKey(current);
      if (
        differentIdentity &&
        storedSelectionKey &&
        incomingSelectionKey <= storedSelectionKey
      ) {
        return current;
      }
      if (
        current.billing.stripeCustomerId &&
        current.billing.stripeCustomerId !== customer
      ) {
        return current;
      }
      return {
        ...current,
        billableStudentCount: studentItem?.quantity ?? 0,
        billing: {
          ...current.billing,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscription.id,
          status: mapping.contractStatus,
          stripeStatus: subscription.status,
          stripeSubscriptionCreatedAt: subscription.created,
          stripeSubscriptionSelectionKey: incomingSelectionKey,
          stripeSubscriptionSelectionVersion: 1,
          stripeBaseSubscriptionItemId: baseItem?.id ?? null,
          stripeStudentSubscriptionItemId: studentItem?.id ?? null,
          stripeCurrentPeriodStart: subscriptionPeriod(baseItem?.current_period_start),
          stripeCurrentPeriodEnd: subscriptionPeriod(baseItem?.current_period_end),
          billingVersion: (current.billing.billingVersion ?? 0) + 1,
        },
        appStatus: mapping.appStatus,
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
}

async function reconcileSelectedSubscription(
  classroomId: string,
  subscription: Stripe.Subscription,
  repository: Repository,
  stripe: StripeGateway,
): Promise<ClassroomDoc> {
  const config = getStripeBillingConfig();
  const classroom = await repository.getClassroom(classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  const mapping = mapStripeSubscriptionStatus(subscription.status);
  if (mapping.access !== "available") {
    const updated = await syncClassroomFromSubscription(classroomId, subscription, repository);
    await blockStudentQuantityOperationForInactiveContract(classroomId, repository);
    return (await repository.getClassroom(classroomId)) ?? updated;
  }
  const analysis = analyzeStudentItems(
    subscription,
    config.classroomStudentPriceId,
    classroom.billing.stripeStudentSubscriptionItemId,
  );
  const existingOperation = classroom.billing.studentQuantityOperation;
  const targetQuantity =
    existingOperation &&
    ["pending", "pending_reconciliation"].includes(existingOperation.status)
      ? existingOperation.targetQuantity
      : analysis.totalEffectiveQuantity;
  const operationVersion =
    existingOperation &&
    ["pending", "pending_reconciliation"].includes(existingOperation.status)
      ? existingOperation.operationVersion
      : `webhook:${subscription.id}:${subscription.created}`;
  await syncClassroomFromSubscription(classroomId, subscription, repository);
  return setBillableStudentQuantity(
    { classroomId, quantity: targetQuantity, operationVersion },
    repository,
    stripe,
  );
}

export async function reconcileClassroomSubscription(
  classroomId: string,
  eventSubscriptionId: string | null,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<ClassroomDoc | null> {
  const classroom = await repository.getClassroom(classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  let customer = classroom.billing.stripeCustomerId;
  if (!customer && eventSubscriptionId) {
    const eventSubscription = await stripeClient.retrieveSubscription(eventSubscriptionId);
    customer = subscriptionCustomerId(eventSubscription);
  }
  if (!customer) throw new ValidationError("Stripe customer is missing for classroom");
  const subscriptions = await stripeClient.listCustomerSubscriptions(customer);
  const candidates = subscriptions
    .filter((subscription) => subscriptionCustomerId(subscription) === customer)
    .filter((subscription) => subscription.metadata.classroomId === classroomId)
    .filter((subscription) => hasClassroomBasePrice(subscription, config.classroomBasePriceId))
    .sort((left, right) => compareStripeSubscriptionSelection(right, left));
  const latest = candidates[0];
  if (latest) {
    return reconcileSelectedSubscription(classroomId, latest, repository, stripeClient);
  }
  if (!eventSubscriptionId) return null;
  const eventSubscription = await stripeClient.retrieveSubscription(eventSubscriptionId);
  if (
    subscriptionCustomerId(eventSubscription) !== customer ||
    eventSubscription.metadata.classroomId !== classroomId ||
    !hasClassroomBasePrice(eventSubscription, config.classroomBasePriceId)
  ) {
    throw new ValidationError("Stripe subscription does not match classroom billing configuration");
  }
  return reconcileSelectedSubscription(classroomId, eventSubscription, repository, stripeClient);
}

export interface SetBillableStudentQuantityInput {
  classroomId: string;
  quantity: number;
  operationVersion: string;
  /**
   * Membership sagas use the lease as the serialization point. When enabled,
   * the quantity is re-read from the authoritative member documents after the
   * lease is acquired instead of trusting the caller's snapshot.
   */
  authoritativeMembershipCount?: boolean;
}

export interface BillingSagaContract {
  membershipStatus: "provisioning" | "active" | "removing";
  externalOperation: "create" | "update" | "delete" | "none";
  compensation: "reconcile";
}

export const BILLING_SAGA_CONTRACT: BillingSagaContract = {
  membershipStatus: "provisioning",
  externalOperation: "update",
  compensation: "reconcile",
};

const STUDENT_OPERATION_LEASE_MS = 5 * 60 * 1000;

async function acquireStudentQuantityLease(
  classroomId: string,
  operationVersion: string,
  targetQuantity: number,
  repository: Repository,
): Promise<{ ownerToken: string; operation: BillingOperationLeaseDoc }> {
  if (!operationVersion.trim() || operationVersion.length > 128 || !/^[\x21-\x7e]+$/.test(operationVersion)) {
    throw new ValidationError("operationVersion must be 1-128 printable ASCII characters");
  }
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("billing repository does not support compare-and-swap");
  }
  const ownerToken = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("billing repository returned no etag");
    const existing = current.document.billing.studentQuantityOperation;
    const now = new Date();
    if (existing?.status === "pending" && existing.expiresAt > now.toISOString()) {
      throw new BillingInProgressError("student quantity update is already in progress");
    }
    const operation: BillingOperationLeaseDoc = {
      operationVersion,
      ownerToken,
      targetQuantity,
      status: "pending",
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + STUDENT_OPERATION_LEASE_MS).toISOString(),
      completedAt: null,
      lastError: null,
    };
    try {
      await repository.upsertClassroom(
        {
          ...current.document,
          billing: { ...current.document.billing, studentQuantityOperation: operation },
          updatedAt: now.toISOString(),
        },
        { ifMatch: current.etag },
      );
      return { ownerToken, operation };
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("student quantity lease retries exhausted");
}

async function finishStudentQuantityLease(
  classroomId: string,
  ownerToken: string,
  status: "completed" | "pending_reconciliation" | "failed",
  repository: Repository,
  errorMessage?: string,
): Promise<void> {
  await updateClassroomWithCas(
    classroomId,
    (current) => {
      const operation = current.billing.studentQuantityOperation;
      if (!operation || operation.ownerToken !== ownerToken) {
        throw new BillingInProgressError("student quantity lease is no longer owned");
      }

      return {
        ...current,
        billing: {
          ...current.billing,
          studentQuantityOperation: {
            ...operation,
            status,
            completedAt: status === "completed" ? new Date().toISOString() : null,
            lastError: errorMessage ?? null,
          },
        },
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
}

async function retargetStudentQuantityLease(
  classroomId: string,
  ownerToken: string,
  targetQuantity: number,
  repository: Repository,
): Promise<void> {
  await updateClassroomWithCas(
    classroomId,
    (current) => {
      const operation = current.billing.studentQuantityOperation;
      if (!operation || operation.ownerToken !== ownerToken || operation.status !== "pending") {
        throw new BillingInProgressError("student quantity lease is no longer owned");
      }
      return {
        ...current,
        billing: {
          ...current.billing,
          studentQuantityOperation: {
            ...operation,
            targetQuantity,
          },
        },
        updatedAt: new Date().toISOString(),
      };
    },
    repository,
  );
}

function authoritativeStudentQuantity(
  members: ClassroomMemberDoc[],
): number {
  return members.filter(
    (member) =>
      member.role === "student" &&
      (member.status === "active" ||
        (member.status === "provisioning" && member.billingDesiredStatus === "active")),
  ).length;
}

async function acquireStudentQuantityLeaseForSaga(
  input: SetBillableStudentQuantityInput,
  repository: Repository,
): Promise<{ ownerToken: string; operation: BillingOperationLeaseDoc }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await acquireStudentQuantityLease(
        input.classroomId,
        input.operationVersion,
        input.quantity,
        repository,
      );
    } catch (error) {
      if (
        !input.authoritativeMembershipCount ||
        !(error instanceof BillingInProgressError) ||
        attempt >= 50
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function studentSubscriptionItems(
  subscription: Stripe.Subscription,
  studentPriceId: string,
): Stripe.SubscriptionItem[] {
  return subscription.items.data
    .filter((item) => subscriptionItemPriceId(item) === studentPriceId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalStudentItem(
  items: Stripe.SubscriptionItem[],
  preferredId: string | null | undefined,
): Stripe.SubscriptionItem | undefined {
  return items.find((item) => item.id === preferredId) ?? items[0];
}

interface StudentItemAnalysis {
  canonicalItem: Stripe.SubscriptionItem | undefined;
  duplicateItems: Stripe.SubscriptionItem[];
  totalEffectiveQuantity: number;
}

function analyzeStudentItems(
  subscription: Stripe.Subscription,
  studentPriceId: string,
  preferredId?: string | null,
): StudentItemAnalysis {
  const items = studentSubscriptionItems(subscription, studentPriceId);
  const canonicalItem = canonicalStudentItem(items, preferredId);
  return {
    canonicalItem,
    duplicateItems: items.filter((item) => item.id !== canonicalItem?.id),
    totalEffectiveQuantity: items.reduce((total, item) => total + (item.quantity ?? 0), 0),
  };
}

export async function setBillableStudentQuantity(
  input: SetBillableStudentQuantityInput,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<ClassroomDoc> {
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new ValidationError("student quantity must be a non-negative integer");
  }
  const classroom = await repository.getClassroom(input.classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  if (!classroom.billing.stripeSubscriptionId) throw new ValidationError("classroom has no Stripe subscription");
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  const lease = await acquireStudentQuantityLeaseForSaga(input, repository);
  let externalMutationSucceeded = false;
  try {
    const current = await repository.getClassroom(input.classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    const subscriptionId = current.billing.stripeSubscriptionId;
    if (!subscriptionId) throw new ValidationError("classroom has no Stripe subscription");
    let targetQuantity = input.quantity;
    if (input.authoritativeMembershipCount) {
      const members = await repository.listClassroomMembers(input.classroomId);
      targetQuantity = authoritativeStudentQuantity(members);
      await retargetStudentQuantityLease(
        input.classroomId,
        lease.ownerToken,
        targetQuantity,
        repository,
      );
    }
    const subscription = await stripeClient.retrieveSubscription(subscriptionId);
    const mapping = mapStripeSubscriptionStatus(subscription.status);
    if (mapping.access !== "available") {
      throw new ValidationError("classroom subscription is not available");
    }
    const baseItem = subscription.items.data.find((candidate) => subscriptionItemPriceId(candidate) === config.classroomBasePriceId);
    if (!baseItem) throw new ValidationError("Stripe subscription is missing the classroom base price");
    const analysis = analyzeStudentItems(
      subscription,
      config.classroomStudentPriceId,
      current.billing.stripeStudentSubscriptionItemId,
    );
    const canonical = analysis.canonicalItem;
    const mutationKey = `classroom:${input.classroomId}:membership:${operationKeyHash(input.operationVersion)}`;
    for (const extra of analysis.duplicateItems) {
      externalMutationSucceeded = true;
      await stripeClient.deleteSubscriptionItem(
        extra.id,
        { proration_behavior: "always_invoice" },
        { idempotencyKey: `${mutationKey}:delete:${extra.id}` },
      );
    }
    if (targetQuantity === 0) {
      if (canonical) {
        externalMutationSucceeded = true;
        await stripeClient.deleteSubscriptionItem(
          canonical.id,
          { proration_behavior: "always_invoice" },
          { idempotencyKey: `${mutationKey}:delete:${canonical.id}` },
        );
      }
    } else if (canonical) {
      if (canonical.quantity !== targetQuantity) {
        externalMutationSucceeded = true;
        await stripeClient.updateSubscriptionItem(
          canonical.id,
          { quantity: targetQuantity, proration_behavior: "always_invoice" },
          { idempotencyKey: `${mutationKey}:update:${canonical.id}` },
        );
      }
    } else {
      externalMutationSucceeded = true;
      await stripeClient.createSubscriptionItem(
        {
          subscription: subscription.id,
          price: config.classroomStudentPriceId,
          quantity: targetQuantity,
          proration_behavior: "always_invoice",
        },
        { idempotencyKey: `${mutationKey}:create` },
      );
    }
    const remote = await stripeClient.retrieveSubscription(subscription.id);
    const finalAnalysis = analyzeStudentItems(remote, config.classroomStudentPriceId);
    const exactStudentQuantity =
      finalAnalysis.duplicateItems.length === 0 &&
      (targetQuantity === 0
        ? !finalAnalysis.canonicalItem || finalAnalysis.canonicalItem.quantity === 0
        : finalAnalysis.canonicalItem?.quantity === targetQuantity);
    if (!exactStudentQuantity) {
      throw new BillingInProgressError("student quantity reconciliation is incomplete");
    }
    const result = await syncClassroomFromSubscription(input.classroomId, remote, repository);
    await finishStudentQuantityLease(input.classroomId, lease.ownerToken, "completed", repository);
    return result;
  } catch (error) {
    try {
      await finishStudentQuantityLease(
        input.classroomId,
        lease.ownerToken,
        externalMutationSucceeded ? "pending_reconciliation" : "failed",
        repository,
        error instanceof Error ? error.name : "student quantity update failed",
      );
    } catch (leaseError) {
      if (!(leaseError instanceof BillingInProgressError)) throw leaseError;
    }
    throw error;
  }
}

export async function reconcileBillableStudentQuantity(
  classroomId: string,
  operationVersion: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<ClassroomDoc> {
  return setBillableStudentQuantity(
    { classroomId, quantity: 0, operationVersion, authoritativeMembershipCount: true },
    repository,
    stripe,
  );
}

function hashPayload(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

async function findClassroomForEvent(
  event: Stripe.Event,
  repository: Repository,
): Promise<ClassroomDoc | null> {
  const object = event.data.object;
  const metadata = "metadata" in object && object.metadata ? object.metadata : undefined;
  const metadataClassroomId = metadata?.classroomId;
  if (metadataClassroomId) {
    const classroom = await repository.getClassroom(metadataClassroomId);
    if (classroom) return classroom;
  }
  if (event.type.startsWith("checkout.session.")) {
    const session = object as Stripe.Checkout.Session;
    const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
    return customer && repository.findClassroomByStripeCustomerId
      ? repository.findClassroomByStripeCustomerId(customer)
      : null;
  }
  if ("customer" in object) {
    const customer = typeof object.customer === "string" ? object.customer : object.customer?.id;
    if (customer && repository.findClassroomByStripeCustomerId) {
      const classroom = await repository.findClassroomByStripeCustomerId(customer);
      if (classroom) return classroom;
    }
  }
  const subscription =
    event.type.startsWith("customer.subscription.") && "id" in object
      ? object.id
      : null;
  return subscription && repository.findClassroomByStripeSubscriptionId
    ? repository.findClassroomByStripeSubscriptionId(subscription)
    : null;
}

const BILLING_EVENT_LEASE_MS = 5 * 60 * 1000;
const PORTAL_RETRY_WINDOW_MS = 30 * 1000;

interface BillingEventLease {
  event: BillingEventDoc;
  ownerToken: string;
}

async function acquireBillingEventLease(
  event: BillingEventDoc,
  repository: Repository,
  ownerToken: string,
): Promise<BillingEventLease | null> {
  if (!repository.getBillingEventRecord) {
    throw new ConfigurationError("billing repository does not support event CAS");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getBillingEventRecord(event.id);
    const now = new Date();
    if (!current) {
      const initial: BillingEventDoc = {
        ...event,
        status: "processing",
        attemptCount: 1,
        lastError: null,
        processingOwnerToken: ownerToken,
        processingStartedAt: now.toISOString(),
        processingExpiresAt: new Date(now.getTime() + BILLING_EVENT_LEASE_MS).toISOString(),
      };
      try {
        await repository.createBillingEvent(initial, { ifNoneMatch: true });
        return { event: initial, ownerToken };
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        continue;
      }
    }
    if (!current.etag) throw new ConfigurationError("billing repository returned no event etag");
    if (current.document.status === "processed") return null;
    const leaseActive =
      current.document.status === "processing" &&
      current.document.processingExpiresAt !== null &&
      current.document.processingExpiresAt !== undefined &&
      current.document.processingExpiresAt > now.toISOString();
    if (leaseActive) throw new BillingInProgressError();
    const next: BillingEventDoc = {
      ...current.document,
      status: "processing",
      attemptCount: (current.document.attemptCount ?? 0) + 1,
      lastError: null,
      processedAt: null,
      processingOwnerToken: ownerToken,
      processingStartedAt: now.toISOString(),
      processingExpiresAt: new Date(now.getTime() + BILLING_EVENT_LEASE_MS).toISOString(),
    };
    try {
      await repository.upsertBillingEvent(next, { ifMatch: current.etag });
      return { event: next, ownerToken };
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new RepositoryConflictError("billing event lease retries exhausted");
}

async function finishBillingEvent(
  eventId: string,
  ownerToken: string,
  status: "processed" | "failed",
  repository: Repository,
  errorMessage?: string,
): Promise<void> {
  if (!repository.getBillingEventRecord) {
    throw new ConfigurationError("billing repository does not support event CAS");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getBillingEventRecord(eventId);
    if (!current) throw new NotFoundError("billing event disappeared");
    if (!current.etag) throw new ConfigurationError("billing repository returned no event etag");
    if (current.document.processingOwnerToken !== ownerToken) {
      throw new BillingInProgressError("billing event lease is no longer owned");
    }
    const next: BillingEventDoc = {
      ...current.document,
      status,
      processedAt: status === "processed" ? new Date().toISOString() : null,
      lastError: errorMessage ?? null,
      processingOwnerToken: null,
      processingStartedAt: null,
      processingExpiresAt: null,
    };
    try {
      await repository.upsertBillingEvent(next, { ifMatch: current.etag });
      return;
    } catch (conflict) {
      if (!(conflict instanceof RepositoryConflictError) || attempt === 3) throw conflict;
    }
  }
}

export interface WebhookResult {
  status: "processed" | "duplicate" | "ignored" | "failed";
  eventId: string;
}

export async function processStripeWebhook(
  rawBody: string,
  signature: string | null,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<WebhookResult> {
  if (!signature) throw new ValidationError("missing Stripe signature");
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  let event: Stripe.Event;
  try {
    event = stripeClient.constructWebhookEvent(rawBody, signature, config.webhookSecret);
  } catch {
    throw new ValidationError("invalid Stripe signature");
  }
  const lease = await acquireBillingEventLease(
    {
      id: event.id,
      type: "billing-event",
      provider: "stripe",
      eventType: event.type,
      livemode: event.livemode,
      payloadHash: hashPayload(rawBody),
      processedAt: null,
      createdAt: new Date().toISOString(),
      stripeCreatedAt: event.created,
    },
    repository,
    randomUUID(),
  );
  if (!lease) return { status: "duplicate", eventId: event.id };

  try {
    const relevant =
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.expired" ||
      event.type.startsWith("customer.subscription.") ||
      event.type.startsWith("invoice.");
    if (relevant) {
      const classroom = await findClassroomForEvent(event, repository);
      if (classroom) {
        let eventSubscriptionId: string | null = classroom.billing.stripeSubscriptionId;
        if (event.type === "checkout.session.completed") {
          const session = event.data.object as Stripe.Checkout.Session;
          eventSubscriptionId = subscriptionIdFromValue(session.subscription);
          await reconcileClassroomSubscription(classroom.id, eventSubscriptionId, repository, stripeClient);
          await updateCheckoutAttemptStatus(classroom.id, session.id, "completed", repository);
        } else if (event.type === "checkout.session.expired") {
          const session = event.data.object as Stripe.Checkout.Session;
          await updateCheckoutAttemptStatus(classroom.id, session.id, "expired", repository);
        } else if (event.type.startsWith("customer.subscription.")) {
          eventSubscriptionId = (event.data.object as Stripe.Subscription).id;
        } else {
          const invoice = event.data.object as Stripe.Invoice;
          eventSubscriptionId = invoice.parent?.type === "subscription_details" && invoice.parent.subscription_details
            ? subscriptionIdFromValue(invoice.parent.subscription_details.subscription)
            : eventSubscriptionId;
        }
        if (event.type.startsWith("customer.subscription.") || event.type.startsWith("invoice.")) {
          await reconcileClassroomSubscription(classroom.id, eventSubscriptionId, repository, stripeClient);
        }
      }
    }
    await finishBillingEvent(event.id, lease.ownerToken, "processed", repository);
    return { status: relevant ? "processed" : "ignored", eventId: event.id };
  } catch (error) {
    const message = error instanceof Error ? error.name : "billing processing failed";
    await finishBillingEvent(event.id, lease.ownerToken, "failed", repository, message);
    throw error;
  }
}
