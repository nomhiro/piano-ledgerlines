import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountContext, type AccountContext } from "./account";
import { getAvatarLabel } from "@/lib/account-view-model";
import type { AuthenticatedUser } from "./auth";
import type { ClassroomDoc, ClassroomMemberDoc, UserProfileDoc } from "./types";

const user: AuthenticatedUser = {
  id: "google:user",
  roles: [],
  plan: "free",
  provider: "google",
  email: "person@example.com",
  displayName: "👩🏽‍🎼",
  emailVerified: true,
  isDevelopmentFallback: false,
};

function profile(displayName = user.displayName): UserProfileDoc {
  return {
    id: user.id, type: "user", email: user.email, normalizedEmail: user.email,
    displayName, provider: "google", providerSyncedAt: "2026-01-01T00:00:00.000Z",
    settings: { dailyPracticeMinutes: 30, locale: "ja-JP", allowTrainingUse: false, notifyOnAnalysisComplete: true },
    classroomRefs: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("avatar label preserves Unicode grapheme clusters", () => {
  assert.equal(getAvatarLabel("👩🏽‍🎼山", user.email), "👩🏽‍🎼山");
  assert.equal(getAvatarLabel("", "名前@example.com"), "名前");
});

test("personal account context has no classroom selected", () => {
  const context: AccountContext = buildAccountContext(user, profile(), [], []) ;
  assert.equal(context.mode, "individual");
  assert.equal(context.activeClassroom, null);
  assert.equal(context.contractStatus, "none");
});

test("classroom context uses provider display name and role", () => {
  const classroom: ClassroomDoc = {
    id: "classroom_1", type: "classroom", name: "教室", ownerUserId: user.id,
    teacherLimit: 5, billableStudentCount: 0,
    billing: { stripeCustomerId: null, stripeSubscriptionId: null, status: "past_due" },
    appStatus: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const member: ClassroomMemberDoc = {
    id: "classroom_1:google:user", type: "classroom-member", classroomId: classroom.id,
    userId: user.id, role: "teacher", status: "active",
    createdAt: classroom.createdAt, updatedAt: classroom.updatedAt,
  };
  const context = buildAccountContext(user, profile(""), [classroom], [member]);
  assert.equal(context.profile.displayName, "person");
  assert.equal(context.activeClassroom?.role, "teacher");
  assert.equal(context.contractStatus, "past_due");
});

test("inactive classroom remains visible for owner billing recovery", () => {
  const classroom: ClassroomDoc = {
    id: "classroom_inactive", type: "classroom", name: "停止中の教室", ownerUserId: user.id,
    teacherLimit: 5, billableStudentCount: 0,
    billing: { stripeCustomerId: "cus_test", stripeSubscriptionId: null, status: "canceled" },
    appStatus: "suspended", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const member: ClassroomMemberDoc = {
    id: "classroom_inactive:google:user", type: "classroom-member", classroomId: classroom.id,
    userId: user.id, role: "owner", status: "active",
    createdAt: classroom.createdAt, updatedAt: classroom.updatedAt,
  };
  const context = buildAccountContext(user, profile(), [classroom], [member]);
  assert.equal(context.mode, "classroom");
  assert.equal(context.activeClassroom?.role, "owner");
  assert.equal(context.permissions.canManageBilling, true);
});
