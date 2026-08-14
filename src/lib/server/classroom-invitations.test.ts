import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { LocalRepository } from "./repository";
import { createDraftClassroom, setBillableStudentQuantity } from "./billing";
import { upsertAuthenticatedUserProfile } from "./account";
import {
  acceptClassroomInvitation,
  createClassroomInvitation,
  removeClassroomMember,
  resendClassroomInvitation,
  revokeClassroomInvitation,
} from "./classroom-invitations";
import { InMemoryEmailSender } from "./email";
import type { AuthenticatedUser } from "./auth";
import type { StripeGateway } from "./stripe";
import type { ClassroomMemberDoc } from "./types";

process.env.STRIPE_SECRET_KEY ??= "sk_test_classroom";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_classroom";
process.env.STRIPE_CLASSROOM_BASE_PRICE_ID ??= "price_classroom_base";
process.env.STRIPE_CLASSROOM_STUDENT_PRICE_ID ??= "price_classroom_student";
process.env.LEDGERLINES_APP_BASE_URL ??= "http://localhost:3000";

function googleUser(id: string, email: string): AuthenticatedUser {
  return {
    id,
    roles: [],
    plan: "free",
    provider: "google",
    email,
    displayName: id,
    emailVerified: true,
    isDevelopmentFallback: false,
  };
}

class QuantityGateway implements StripeGateway {
  readonly subscription: Stripe.Subscription;
  retrieveStarted: Promise<void>;
  private releaseRetrieve: (() => void) | null = null;
  private markRetrieveStarted: (() => void) | null = null;
  gateRetrieve = false;

  constructor(classroomId: string) {
    this.subscription = {
      id: "sub_test",
      object: "subscription",
      customer: "cus_test",
      status: "active",
      created: 1,
      metadata: { classroomId },
      items: {
        object: "list",
        data: [{
          id: "base-item",
          object: "subscription_item",
          price: { id: "price_classroom_base" },
          quantity: 1,
        }],
        has_more: false,
        url: null,
      },
    } as unknown as Stripe.Subscription;
    this.retrieveStarted = new Promise((resolve) => {
      this.markRetrieveStarted = resolve;
    });
  }

  holdNextRetrieve(): void {
    this.gateRetrieve = true;
    this.releaseRetrieve = () => {
      this.gateRetrieve = false;
    };
  }

  release(): void {
    this.releaseRetrieve?.();
  }

  async createCustomer(): Promise<Stripe.Customer> {
    throw new Error("not used");
  }

  async createCheckoutSession(): Promise<Stripe.Checkout.Session> {
    throw new Error("not used");
  }

  async createBillingPortalSession(): Promise<Stripe.BillingPortal.Session> {
    throw new Error("not used");
  }

  async retrieveSubscription(): Promise<Stripe.Subscription> {
    this.markRetrieveStarted?.();
    if (this.gateRetrieve) {
      await new Promise<void>((resolve) => {
        const previous = this.releaseRetrieve;
        this.releaseRetrieve = () => {
          previous?.();
          resolve();
        };
      });
    }
    return this.subscription;
  }

  async listCustomerSubscriptions(): Promise<Stripe.Subscription[]> {
    return [this.subscription];
  }

  async createSubscriptionItem(
    params: Stripe.SubscriptionItemCreateParams,
  ): Promise<Stripe.SubscriptionItem> {
    const item = {
      id: `student-item-${this.subscription.items.data.length}`,
      object: "subscription_item",
      price: { id: "price_classroom_student" },
      quantity: params.quantity ?? 0,
    } as Stripe.SubscriptionItem;
    this.subscription.items.data.push(item);
    return item;
  }

  async updateSubscriptionItem(
    itemId: string,
    params: Stripe.SubscriptionItemUpdateParams,
  ): Promise<Stripe.SubscriptionItem> {
    const item = this.subscription.items.data.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("missing subscription item");
    item.quantity = params.quantity ?? item.quantity;
    return item;
  }

  async deleteSubscriptionItem(itemId: string): Promise<Stripe.DeletedSubscriptionItem> {
    this.subscription.items.data = this.subscription.items.data.filter((item) => item.id !== itemId);
    return { id: itemId, deleted: true } as Stripe.DeletedSubscriptionItem;
  }

  constructWebhookEvent(): Stripe.Event {
    throw new Error("not used");
  }
}

function studentMember(classroomId: string, userId: string, status: ClassroomMemberDoc["status"], billingDesiredStatus: ClassroomMemberDoc["billingDesiredStatus"]): ClassroomMemberDoc {
  const timestamp = new Date().toISOString();
  return {
    id: `member-${userId}`,
    type: "classroom-member",
    classroomId,
    userId,
    role: "student",
    status,
    billingDesiredStatus,
    operationVersion: `test:${userId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class PausingMemberRepository extends LocalRepository {
  private pauseNextProvisioningRead = true;
  private releaseRead: (() => void) | null = null;
  private markEntered: (() => void) | null = null;
  readonly provisioningReadStarted = new Promise<void>((resolve) => {
    this.markEntered = resolve;
  });

  async getClassroomMemberRecord(classroomId: string, userId: string) {
    const record = await super.getClassroomMemberRecord(classroomId, userId);
    if (this.pauseNextProvisioningRead && record?.document.status === "provisioning") {
      this.pauseNextProvisioningRead = false;
      this.markEntered?.();
      await new Promise<void>((resolve) => {
        this.releaseRead = resolve;
      });
    }

    return record;
  }

  releaseProvisioningRead(): void {
    this.releaseRead?.();
  }
}

class CrashOnceMemberRepository extends LocalRepository {
  private failNextProvisioningRead = true;

  async getClassroomMemberRecord(classroomId: string, userId: string) {
    const record = await super.getClassroomMemberRecord(classroomId, userId);
    if (this.failNextProvisioningRead && record?.document.status === "provisioning") {
      this.failNextProvisioningRead = false;
      throw new Error("simulated crash after invitation claim");
    }
    return record;
  }
}

async function activeClassroom(repository: LocalRepository, owner: AuthenticatedUser) {
  await upsertAuthenticatedUserProfile(owner, repository);
  const classroom = await createDraftClassroom(owner.id, { name: "Invitation test" }, repository);
  const record = await repository.getClassroomRecord(classroom.id);
  assert.ok(record?.etag);
  return repository.upsertClassroom({
    ...classroom,
    appStatus: "active",
    billing: {
      ...classroom.billing,
      status: "active",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
    },
  }, { ifMatch: record.etag });
}

test("teacher seat reservation is CAS-safe and token hash is never returned", async () => {
  const repository = new LocalRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const sender = new InMemoryEmailSender();
  const results = await Promise.allSettled([
    createClassroomInvitation(classroom.id, owner, { email: "teacher@example.com", role: "teacher" }, repository, sender),
    createClassroomInvitation(classroom.id, owner, { email: "teacher@example.com", role: "teacher" }, repository, sender),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await repository.listClassroomInvitations(classroom.id)).length, 1);
  assert.equal((await repository.getClassroom(classroom.id))?.reservedTeacherSeatCount, 1);
  const success = results.find((result) => result.status === "fulfilled");
  assert.ok(success);
  if (success.status !== "fulfilled") throw new Error("invitation creation did not succeed");
  assert.equal(Object.prototype.hasOwnProperty.call(success.value.invitation, "tokenHash"), false);
  assert.equal(sender.messages.length, 1);
});

test("acceptance requires exact Google email and accepts a teacher token once", async () => {
  const repository = new LocalRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const sender = new InMemoryEmailSender();
  const invite = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: "teacher-accept@example.com", role: "teacher" },
    repository,
    sender,
  );
  const values = new URLSearchParams(new URL(invite.invitationUrl).hash.slice(1));
  const input = {
    classroomId: values.get("classroomId")!,
    invitationId: values.get("invitationId")!,
    secret: values.get("secret")!,
  };
  await assert.rejects(
    acceptClassroomInvitation(input, googleUser("wrong", "wrong@example.com"), repository),
    /does not match/,
  );
  const teacher = googleUser("teacher-accept", "teacher-accept@example.com");
  const accepted = await acceptClassroomInvitation(input, teacher, repository);
  assert.deepEqual(accepted, { classroomId: classroom.id, role: "teacher", status: "active" });
  assert.equal((await repository.getClassroomInvitation(classroom.id, input.invitationId))?.status, "accepted");
  assert.equal((await repository.getClassroomMember(classroom.id, teacher.id))?.status, "active");
  assert.deepEqual(await acceptClassroomInvitation(input, teacher, repository), accepted);
});

test("membership billing lease re-reads accepted provisioning and converges concurrent operations", async () => {
  const repository = new LocalRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const firstMember = studentMember(classroom.id, "student-a", "provisioning", "active");
  const secondMember = studentMember(classroom.id, "student-b", "provisioning", "active");
  await repository.createClassroomMember(firstMember, { ifNoneMatch: true });
  await repository.createClassroomMember(secondMember, { ifNoneMatch: true });
  const gateway = new QuantityGateway(classroom.id);
  gateway.holdNextRetrieve();

  const firstAccept = setBillableStudentQuantity({
    classroomId: classroom.id,
    quantity: 0,
    operationVersion: "accept-a",
    authoritativeMembershipCount: true,
  }, repository, gateway);
  await gateway.retrieveStarted;
  const secondAccept = setBillableStudentQuantity({
    classroomId: classroom.id,
    quantity: 0,
    operationVersion: "accept-b",
    authoritativeMembershipCount: true,
  }, repository, gateway);
  await new Promise((resolve) => setTimeout(resolve, 20));
  gateway.release();
  await Promise.all([firstAccept, secondAccept]);
  assert.equal(gateway.subscription.items.data.find((item) => item.price && typeof item.price !== "string" && item.price.id === "price_classroom_student")?.quantity, 2);
  assert.equal((await repository.getClassroom(classroom.id))?.billableStudentCount, 2);

  const firstRemoving = { ...firstMember, status: "removing" as const, billingDesiredStatus: "removed" as const };
  const secondRemoving = { ...secondMember, status: "removing" as const, billingDesiredStatus: "removed" as const };
  await repository.upsertClassroomMember(firstRemoving);
  await repository.upsertClassroomMember(secondRemoving);
  await Promise.all([
    setBillableStudentQuantity({
      classroomId: classroom.id,
      quantity: 0,
      operationVersion: "remove-a",
      authoritativeMembershipCount: true,
    }, repository, gateway),
    setBillableStudentQuantity({
      classroomId: classroom.id,
      quantity: 0,
      operationVersion: "remove-b",
      authoritativeMembershipCount: true,
    }, repository, gateway),
  ]);
  assert.equal(gateway.subscription.items.data.some((item) => item.price && typeof item.price !== "string" && item.price.id === "price_classroom_student"), false);
  assert.equal((await repository.getClassroom(classroom.id))?.billableStudentCount, 0);
  assert.equal((await repository.listClassroomMembers(classroom.id)).filter((member) => member.status === "removing").length, 2);
});

test("authoritative membership quantity excludes removing while accepting provisioning", async () => {
  const repository = new LocalRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  await repository.createClassroomMember(studentMember(classroom.id, "student-active", "active", null), { ifNoneMatch: true });
  await repository.createClassroomMember(studentMember(classroom.id, "student-accepting", "provisioning", "active"), { ifNoneMatch: true });
  await repository.createClassroomMember(studentMember(classroom.id, "student-removing", "removing", "removed"), { ifNoneMatch: true });
  const gateway = new QuantityGateway(classroom.id);
  await setBillableStudentQuantity({
    classroomId: classroom.id,
    quantity: 0,
    operationVersion: "accept-remove",
    authoritativeMembershipCount: true,
  }, repository, gateway);
  assert.equal(gateway.subscription.items.data.find((item) => item.price && typeof item.price !== "string" && item.price.id === "price_classroom_student")?.quantity, 2);
  assert.equal((await repository.getClassroom(classroom.id))?.billableStudentCount, 2);
});

test("accepting claim fences revoke and old-token replay", async () => {
  const repository = new LocalRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const teacherId = `claim-teacher-${Date.now()}`;
  const teacher = googleUser(teacherId, `${teacherId}@example.com`);
  const sender = new InMemoryEmailSender();
  const invitation = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: teacher.email, role: "teacher" },
    repository,
    sender,
  );
  const values = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1));
  const input = {
    classroomId: values.get("classroomId")!,
    invitationId: values.get("invitationId")!,
    secret: values.get("secret")!,
  };
  await revokeClassroomInvitation(classroom.id, input.invitationId, owner.id, repository);
  await assert.rejects(acceptClassroomInvitation(input, teacher, repository), /no longer available/);
  assert.equal(await repository.getClassroomMember(classroom.id, teacher.id), null);

  const resendInvitation = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: teacher.email, role: "teacher" },
    repository,
    sender,
  );
  const resendValues = new URLSearchParams(new URL(resendInvitation.invitationUrl).hash.slice(1));
  const oldTokenInput = {
    classroomId: resendValues.get("classroomId")!,
    invitationId: resendValues.get("invitationId")!,
    secret: resendValues.get("secret")!,
  };
  await resendClassroomInvitation(classroom.id, oldTokenInput.invitationId, owner.id, repository, sender);
  await assert.rejects(acceptClassroomInvitation(oldTokenInput, teacher, repository), /token is invalid/);
});

test("teacher removal cannot resurrect an accepting generation and reinvite starts a new generation", async () => {
  const repository = new PausingMemberRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const teacherId = `fenced-teacher-${Date.now()}`;
  const teacher = googleUser(teacherId, `${teacherId}@example.com`);
  const sender = new InMemoryEmailSender();
  const invitation = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: teacher.email, role: "teacher" },
    repository,
    sender,
  );
  const values = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1));
  const input = {
    classroomId: values.get("classroomId")!,
    invitationId: values.get("invitationId")!,
    secret: values.get("secret")!,
  };
  const accepting = acceptClassroomInvitation(input, teacher, repository);
  await repository.provisioningReadStarted;
  await removeClassroomMember(classroom.id, teacher.id, owner.id, repository);
  repository.releaseProvisioningRead();
  await assert.rejects(accepting, /membership/);
  assert.equal((await repository.getClassroomMember(classroom.id, teacher.id))?.status, "removed");
  assert.equal((await repository.getUser(teacher.id))?.classroomRefs.length, 0);
  assert.equal((await repository.getClassroomInvitation(classroom.id, input.invitationId))?.status, "revoked");

  const reinvite = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: teacher.email, role: "teacher" },
    repository,
    sender,
  );
  const reinviteValues = new URLSearchParams(new URL(reinvite.invitationUrl).hash.slice(1));
  const accepted = await acceptClassroomInvitation({
    classroomId: reinviteValues.get("classroomId")!,
    invitationId: reinviteValues.get("invitationId")!,
    secret: reinviteValues.get("secret")!,
  }, teacher, repository);
  assert.equal(accepted.status, "active");
  assert.equal((await repository.getClassroomMember(classroom.id, teacher.id))?.generation, 2);
});

test("same claimed token resumes after a crash without a false accepted state", async () => {
  const repository = new CrashOnceMemberRepository();
  const owner = googleUser(`owner-${Date.now()}`, `owner-${Date.now()}@example.com`);
  const classroom = await activeClassroom(repository, owner);
  const teacherId = `crash-teacher-${Date.now()}`;
  const teacher = googleUser(teacherId, `${teacherId}@example.com`);
  const sender = new InMemoryEmailSender();
  const invitation = await createClassroomInvitation(
    classroom.id,
    owner,
    { email: teacher.email, role: "teacher" },
    repository,
    sender,
  );
  const values = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1));
  const input = {
    classroomId: values.get("classroomId")!,
    invitationId: values.get("invitationId")!,
    secret: values.get("secret")!,
  };
  await assert.rejects(acceptClassroomInvitation(input, teacher, repository), /simulated crash/);
  assert.equal((await repository.getClassroomInvitation(classroom.id, input.invitationId))?.status, "accepting");
  assert.equal((await repository.getClassroomMember(classroom.id, teacher.id))?.status, "provisioning");
  const resumed = await acceptClassroomInvitation(input, teacher, repository);
  assert.equal(resumed.status, "active");
  assert.equal((await repository.getClassroomInvitation(classroom.id, input.invitationId))?.status, "accepted");
});
