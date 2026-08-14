import type { AuthenticatedUser } from "./auth";
export { safeAccountDisplayName, getAvatarLabel } from "@/lib/account-view-model";
import { safeAccountDisplayName } from "@/lib/account-view-model";
import { AuthError, getAuthenticatedServerUser } from "./auth";
import { classroomHasPaidEntitlement } from "./billing";
import {
  getRepository,
  RepositoryConflictError,
  type Repository,
} from "./repository";
import type {
  ClassroomContractStatus,
  ClassroomDoc,
  ClassroomMemberDoc,
  ClassroomMemberStatus,
  ClassroomRole,
  UserProfileDoc,
  UserSettings,
} from "./types";

export const DEFAULT_USER_SETTINGS: UserSettings = {
  dailyPracticeMinutes: 30,
  locale: "ja-JP",
  allowTrainingUse: false,
  notifyOnAnalysisComplete: true,
};

export interface AccountProfile {
  id: string;
  email: string;
  displayName: string;
  provider: AuthenticatedUser["provider"];
  settings: UserSettings;
}

export interface AccountClassroomSummary {
  id: string;
  name: string;
  role: ClassroomRole;
  membershipStatus: ClassroomMemberStatus;
  appStatus: ClassroomDoc["appStatus"];
  contractStatus: ClassroomContractStatus;
  teacherLimit: number;
  billableStudentCount: number;
}

export interface AccountPermissions {
  canWriteOwnData: true;
  canManageClassroom: boolean;
  canInviteTeachers: boolean;
  canManageBilling: boolean;
  canViewStudentData: boolean;
}

export interface AccountEntitlement {
  monthlyTakeLimit: number | null;
  teacherLimit: number | null;
  source: "individual" | "classroom";
}

export interface AccountContext {
  user: {
    id: string;
    email: string;
    displayName: string;
    provider: AuthenticatedUser["provider"];
    plan: AuthenticatedUser["plan"];
  };
  profile: AccountProfile;
  mode: "individual" | "classroom";
  classrooms: AccountClassroomSummary[];
  activeClassroom: AccountClassroomSummary | null;
  contractStatus: ClassroomContractStatus;
  permissions: AccountPermissions;
  entitlement: AccountEntitlement;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function createUserProfile(user: AuthenticatedUser, now = new Date().toISOString()): UserProfileDoc {
  return {
    id: user.id,
    type: "user",
    email: user.email,
    normalizedEmail: normalizeEmail(user.email),
    displayName: user.displayName,
    provider: user.provider,
    providerSyncedAt: now,
    settings: { ...DEFAULT_USER_SETTINGS },
    classroomRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertAuthenticatedUserProfile(
  user: AuthenticatedUser,
  repository: Repository = getRepository(),
  now = new Date().toISOString(),
): Promise<UserProfileDoc> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await repository.getUserRecord(user.id);
    if (!existing) {
      try {
        return await repository.upsertUser(createUserProfile(user, now), { ifNoneMatch: true });
      } catch (error) {
        if (!(error instanceof RepositoryConflictError) || attempt === maxAttempts - 1) {
          throw error;
        }
        continue;
      }
    }

    const next: UserProfileDoc = {
      ...existing.document,
      email: user.email,
      normalizedEmail: normalizeEmail(user.email),
      displayName: user.displayName,
      provider: user.provider,
      providerSyncedAt: now,
      updatedAt: now,
    };
    try {
      return await repository.upsertUserRecord(next, { ifMatch: existing.etag ?? undefined }).then(
        (result) => result.document,
      );
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }
  throw new RepositoryConflictError("user profile synchronization retries exhausted");
}

export function buildAccountContext(
  user: AuthenticatedUser,
  profile: UserProfileDoc,
  classrooms: ClassroomDoc[],
  members: ClassroomMemberDoc[],
): AccountContext {
  const byClassroom = new Map(classrooms.map((classroom) => [classroom.id, classroom]));
  const summaries = members
    .map((member): AccountClassroomSummary | null => {
      const classroom = byClassroom.get(member.classroomId);
      if (!classroom) return null;
      return {
        id: classroom.id,
        name: classroom.name,
        role: member.role,
        membershipStatus: member.status,
        appStatus: classroom.appStatus,
        contractStatus: classroom.billing.status,
        teacherLimit: classroom.teacherLimit,
        billableStudentCount: classroom.billableStudentCount,
      };
    })
    .filter((summary): summary is AccountClassroomSummary => summary !== null);
  const activeClassroom =
    summaries.find(
      (summary) => summary.membershipStatus === "active" && summary.appStatus === "active",
    ) ?? null;
  const mode = activeClassroom ? "classroom" : "individual";
  const contractStatus = activeClassroom?.contractStatus ?? "none";
  const owner = activeClassroom?.role === "owner";
  const teacher = activeClassroom?.role === "teacher";
  const classroomEntitlement =
    mode === "classroom" && classroomHasPaidEntitlement(contractStatus);

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      provider: user.provider,
      plan: user.plan,
    },
    profile: {
      id: profile.id,
      email: profile.email,
      displayName: safeAccountDisplayName(profile.displayName, profile.email),
      provider: profile.provider,
      settings: profile.settings,
    },
    mode,
    classrooms: summaries,
    activeClassroom,
    contractStatus,
    permissions: {
      canWriteOwnData: true,
      canManageClassroom: owner,
      canInviteTeachers: owner,
      canManageBilling: owner,
      canViewStudentData: owner || teacher,
    },
    entitlement: {
      monthlyTakeLimit: classroomEntitlement || user.plan === "paid" ? null : 5,
      teacherLimit: activeClassroom?.teacherLimit ?? null,
      source: mode,
    },
  };
}

export async function getAccountContext(
  user?: AuthenticatedUser,
  repository: Repository = getRepository(),
): Promise<AccountContext> {
  const authenticatedUser = user ?? (await getAuthenticatedServerUser());
  const profile = await upsertAuthenticatedUserProfile(authenticatedUser, repository);
  const ownedClassrooms = await repository.listClassroomsByOwner(authenticatedUser.id);
  const referencedClassroomIds = new Set(profile.classroomRefs.map((reference) => reference.classroomId));
  for (const classroom of ownedClassrooms) referencedClassroomIds.add(classroom.id);

  const classrooms: ClassroomDoc[] = [];
  const members: ClassroomMemberDoc[] = [];
  for (const classroomId of referencedClassroomIds) {
    const classroom = await repository.getClassroom(classroomId);
    if (!classroom) continue;
    const member = await repository.getClassroomMember(classroomId, authenticatedUser.id);
    if (!member) continue;
    classrooms.push(classroom);
    members.push(member);
  }
  return buildAccountContext(authenticatedUser, profile, classrooms, members);
}

export async function getAccountContextForLayout(
  load: () => Promise<AccountContext> = () => getAccountContext(),
): Promise<AccountContext | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}
