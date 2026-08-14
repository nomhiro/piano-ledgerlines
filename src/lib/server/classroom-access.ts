import { AuthError, type AuthenticatedUser } from "./auth";
import { classroomHasPaidEntitlement } from "./billing";
import { ForbiddenError, NotFoundError } from "./http";
import { getRepository, type Repository } from "./repository";
import type {
  ClassroomDoc,
  ClassroomMemberDoc,
  ClassroomRole,
  UserProfileDoc,
} from "./types";

export interface ClassroomAccess {
  classroom: ClassroomDoc;
  member: ClassroomMemberDoc;
}

export async function requireClassroomRole(
  classroomId: string,
  userId: string,
  roles: ClassroomRole[],
  repository: Repository = getRepository(),
): Promise<ClassroomAccess> {
  const classroom = await repository.getClassroom(classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  const member = await repository.getClassroomMember(classroomId, userId);
  if (!member || member.status !== "active" || !roles.includes(member.role)) {
    throw new ForbiddenError();
  }
  return { classroom, member };
}

export async function requireActiveClassroomAccess(
  classroomId: string,
  userId: string,
  roles: ClassroomRole[] = ["owner", "teacher", "student"],
  repository: Repository = getRepository(),
): Promise<ClassroomAccess> {
  const access = await requireClassroomRole(classroomId, userId, roles, repository);
  if (
    access.classroom.appStatus !== "active" ||
    !classroomHasPaidEntitlement(access.classroom.billing.status)
  ) {
    throw new ForbiddenError("classroom subscription is not active");
  }
  return access;
}

export async function assertTeacherCanAccessStudent(
  classroomId: string,
  teacherUserId: string,
  studentUserId: string,
  repository: Repository = getRepository(),
): Promise<{ classroom: ClassroomDoc; teacher: ClassroomMemberDoc; student: ClassroomMemberDoc }> {
  const access = await requireActiveClassroomAccess(
    classroomId,
    teacherUserId,
    ["owner", "teacher"],
    repository,
  );
  const student = await repository.getClassroomMember(classroomId, studentUserId);
  if (!student || student.role !== "student" || student.status !== "active") {
    throw new ForbiddenError();
  }
  return { classroom: access.classroom, teacher: access.member, student };
}

export function safeClassroomRosterMemberView(
  member: ClassroomMemberDoc,
  profile: UserProfileDoc | null,
  viewerRole: ClassroomRole,
): Record<string, unknown> {
  const displayName = profile?.displayName ?? null;
  if (viewerRole === "student") {
    return { displayName, role: member.role };
  }
  return {
    userId: member.userId,
    role: member.role,
    status: member.status,
    displayName,
    ...(viewerRole === "owner" ? { email: profile?.email ?? null } : {}),
  };
}

export function assertAuthenticatedGoogleUser(user: AuthenticatedUser): void {
  if (user.provider !== "google" || !user.emailVerified) {
    throw new AuthError("a verified Google account is required");
  }
}
