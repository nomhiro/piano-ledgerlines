import assert from "node:assert/strict";
import test from "node:test";
import { LocalRepository } from "./repository";
import { createDraftClassroom } from "./billing";
import { upsertAuthenticatedUserProfile } from "./account";
import {
  acceptClassroomInvitation,
  createClassroomInvitation,
} from "./classroom-invitations";
import { InMemoryEmailSender } from "./email";
import type { AuthenticatedUser } from "./auth";

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
