import { createHash } from "node:crypto";
import Stripe from "stripe";
import {
  ConfigurationError,
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
  ClassroomContractStatus,
  ClassroomDoc,
  ClassroomMemberDoc,
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

export function classroomHasPaidEntitlement(status: ClassroomContractStatus): boolean {
  return status === "active" || status === "past_due";
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
    teacherLimit: 10,
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

export async function createClassroomCheckout(
  classroomId: string,
  userId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<{ url: string; sessionId: string }> {
  const classroom = await requireOwner(classroomId, userId, repository);
  if (classroom.billing.stripeSubscriptionId || classroomHasPaidEntitlement(classroom.billing.status)) {
    throw new ValidationError("classroom already has a contract");
  }
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
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
    { idempotencyKey: `classroom:${classroomId}:checkout` },
  );
  if (!session.url) throw new Error("Stripe checkout session did not return a URL");
  return { url: session.url, sessionId: session.id };
}

export async function createClassroomBillingPortal(
  classroomId: string,
  userId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<{ url: string }> {
  const classroom = await requireOwner(classroomId, userId, repository);
  const customer = classroom.billing.stripeCustomerId;
  if (!customer) throw new ValidationError("classroom has no Stripe customer");
  const config = getStripeBillingConfig();
  const stripeClient = stripe ?? getStripeGateway();
  const session = await stripeClient.createBillingPortalSession(
    {
      customer,
      return_url: buildBillingUrl(config.appBaseUrl, "/classrooms/billing", classroomId),
    },
    { idempotencyKey: `classroom:${classroomId}:portal` },
  );
  return { url: session.url };
}

function subscriptionItemPriceId(item: Stripe.SubscriptionItem): string {
  return typeof item.price === "string" ? item.price : item.price.id;
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
  const mapping = mapStripeSubscriptionStatus(subscription.status);
  const baseItem = subscription.items.data.find((item) => subscriptionItemPriceId(item) === config.classroomBasePriceId);
  const studentItem = subscription.items.data.find((item) => subscriptionItemPriceId(item) === config.classroomStudentPriceId);
  if (!baseItem && mapping.access === "available") {
    throw new ValidationError("Stripe subscription is missing the classroom base price");
  }
  const customer = customerId(subscription.customer);
  return updateClassroomWithCas(
    classroomId,
    (current) => ({
      ...current,
      billableStudentCount: studentItem?.quantity ?? 0,
      billing: {
        ...current.billing,
        stripeCustomerId: customer,
        stripeSubscriptionId: subscription.id,
        status: mapping.contractStatus,
        stripeStatus: subscription.status,
        stripeBaseSubscriptionItemId: baseItem?.id ?? null,
        stripeStudentSubscriptionItemId: studentItem?.id ?? null,
        stripeCurrentPeriodStart: subscriptionPeriod(baseItem?.current_period_start),
        stripeCurrentPeriodEnd: subscriptionPeriod(baseItem?.current_period_end),
        billingVersion: (current.billing.billingVersion ?? 0) + 1,
      },
      appStatus: mapping.appStatus,
      updatedAt: new Date().toISOString(),
    }),
    repository,
  );
}

export interface SetBillableStudentQuantityInput {
  classroomId: string;
  quantity: number;
  operationVersion: string;
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
  const subscription = await stripeClient.retrieveSubscription(classroom.billing.stripeSubscriptionId);
  const mapping = mapStripeSubscriptionStatus(subscription.status);
  if (mapping.access !== "available") {
    throw new ValidationError("classroom subscription is not available");
  }
  const baseItem = subscription.items.data.find((candidate) => subscriptionItemPriceId(candidate) === config.classroomBasePriceId);
  if (!baseItem) throw new ValidationError("Stripe subscription is missing the classroom base price");
  const item = subscription.items.data.find((candidate) => subscriptionItemPriceId(candidate) === config.classroomStudentPriceId);
  const currentQuantity = item?.quantity ?? 0;
  const idempotencyKey = `classroom:${input.classroomId}:membership:${input.operationVersion}`;
  let studentItemId = item?.id ?? null;
  if (currentQuantity < input.quantity) {
    if (item) {
      const updated = await stripeClient.updateSubscriptionItem(
        item.id,
        { quantity: input.quantity, proration_behavior: "always_invoice" },
        { idempotencyKey },
      );
      studentItemId = updated.id;
    } else {
      const created = await stripeClient.createSubscriptionItem(
        {
          subscription: subscription.id,
          price: config.classroomStudentPriceId,
          quantity: input.quantity,
          proration_behavior: "always_invoice",
        },
        { idempotencyKey },
      );
      studentItemId = created.id;
    }
  } else if (currentQuantity > input.quantity) {
    if (input.quantity === 0 && item) {
      await stripeClient.deleteSubscriptionItem(
        item.id,
        { proration_behavior: "always_invoice" },
        { idempotencyKey },
      );
      studentItemId = null;
    } else if (item) {
      await stripeClient.updateSubscriptionItem(
        item.id,
        { quantity: input.quantity, proration_behavior: "always_invoice" },
        { idempotencyKey },
      );
    }
  }
  return updateClassroomWithCas(
    input.classroomId,
    (current) => ({
      ...current,
      billableStudentCount: input.quantity,
      billing: { ...current.billing, stripeStudentSubscriptionItemId: input.quantity === 0 ? null : studentItemId },
      updatedAt: new Date().toISOString(),
    }),
    repository,
  );
}

export async function reconcileBillableStudentQuantity(
  classroomId: string,
  operationVersion: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<ClassroomDoc> {
  const members = await repository.listClassroomMembers(classroomId);
  const quantity = members.filter((member) => member.role === "student" && member.status === "active").length;
  return setBillableStudentQuantity({ classroomId, quantity, operationVersion }, repository, stripe);
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

async function markBillingEvent(
  event: BillingEventDoc,
  repository: Repository,
  status: BillingEventDoc["status"],
  error?: string,
): Promise<void> {
  if (!repository.getBillingEventRecord) throw new ConfigurationError("billing repository does not support event CAS");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getBillingEventRecord(event.id);
    if (!current) throw new NotFoundError("billing event disappeared");
    if (!current.etag) throw new ConfigurationError("billing repository returned no event etag");
    try {
      await repository.upsertBillingEvent(
        {
          ...current.document,
          status,
          attemptCount: (current.document.attemptCount ?? 0) + (status === "processing" ? 1 : 0),
          processedAt: status === "processed" ? new Date().toISOString() : current.document.processedAt,
          lastError: error ?? null,
        },
        { ifMatch: current.etag },
      );
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
  const existing = await repository.getBillingEvent(event.id);
  if (existing?.status === "processed") return { status: "duplicate", eventId: event.id };
  if (!existing) {
    const document: BillingEventDoc = {
      id: event.id,
      type: "billing-event",
      provider: "stripe",
      eventType: event.type,
      livemode: event.livemode,
      payloadHash: hashPayload(rawBody),
      processedAt: null,
      createdAt: new Date().toISOString(),
      status: "processing",
      attemptCount: 1,
      lastError: null,
      stripeCreatedAt: event.created,
    };
    try {
      await repository.createBillingEvent(document, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      const duplicate = await repository.getBillingEvent(event.id);
      if (duplicate?.status === "processed") return { status: "duplicate", eventId: event.id };
      if (duplicate?.status === "processing") return { status: "duplicate", eventId: event.id };
    }
  } else if (existing.status === "processing") {
    return { status: "duplicate", eventId: event.id };
  } else {
    await markBillingEvent(existing, repository, "processing");
  }

  try {
    const relevant =
      event.type === "checkout.session.completed" ||
      event.type.startsWith("customer.subscription.") ||
      event.type.startsWith("invoice.");
    if (relevant) {
      const classroom = await findClassroomForEvent(event, repository);
      if (classroom) {
        let subscriptionId: string | null = classroom.billing.stripeSubscriptionId;
        if (event.type === "checkout.session.completed") {
          subscriptionId = subscriptionIdFromValue((event.data.object as Stripe.Checkout.Session).subscription);
        } else if (event.type.startsWith("customer.subscription.")) {
          subscriptionId = (event.data.object as Stripe.Subscription).id;
        } else {
          const invoice = event.data.object as Stripe.Invoice;
          subscriptionId = invoice.parent?.type === "subscription_details" && invoice.parent.subscription_details
            ? subscriptionIdFromValue(invoice.parent.subscription_details.subscription)
            : subscriptionId;
        }
        if (subscriptionId) {
          const latest = await stripeClient.retrieveSubscription(subscriptionId);
          await syncClassroomFromSubscription(classroom.id, latest, repository);
        }
      }
    }
    await markBillingEvent(
      {
        id: event.id,
        type: "billing-event",
        provider: "stripe",
        eventType: event.type,
        livemode: event.livemode,
        payloadHash: hashPayload(rawBody),
        processedAt: null,
        createdAt: new Date().toISOString(),
      },
      repository,
      "processed",
    );
    return { status: relevant ? "processed" : "ignored", eventId: event.id };
  } catch (error) {
    const message = error instanceof Error ? error.name : "billing processing failed";
    const current = await repository.getBillingEvent(event.id);
    if (current) await markBillingEvent(current, repository, "failed", message);
    throw error;
  }
}
