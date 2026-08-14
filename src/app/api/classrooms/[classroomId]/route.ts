import { getAuthenticatedUser } from "@/lib/server/auth";
import { requireClassroomRole, safeMemberView } from "@/lib/server/classroom-access";
import { errorResponse, ConflictError, ConfigurationError, jsonResponse, readJson, ValidationError } from "@/lib/server/http";
import { getRepository, RepositoryConflictError } from "@/lib/server/repository";
import type { ClassroomDoc } from "@/lib/server/types";
import { z } from "zod";

export const runtime = "nodejs";

const updateClassroomSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

function safeClassroomView(classroom: ClassroomDoc) {
  return {
    id: classroom.id,
    name: classroom.name,
    appStatus: classroom.appStatus,
    contractStatus: classroom.billing.status,
    teacherLimit: classroom.teacherLimit,
    billableStudentCount: classroom.billableStudentCount,
    hasBillingCustomer: Boolean(classroom.billing.stripeCustomerId),
  };
}

async function updateClassroomName(
  classroomId: string,
  userId: string,
  name: string,
) {
  const repository = getRepository();
  await requireClassroomRole(classroomId, userId, ["owner"], repository);
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("classroom repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new ConflictError("classroom changed or was removed");
    if (!current.etag) throw new ConfigurationError("classroom version is unavailable");
    try {
      return await repository.upsertClassroom(
        { ...current.document, name, updatedAt: new Date().toISOString() },
        { ifMatch: current.etag },
      );
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 3) throw error;
    }
  }
  throw new ConflictError("classroom update could not be completed");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const repository = getRepository();
    const access = await requireClassroomRole(
      classroomId,
      user.id,
      ["owner", "teacher", "student"],
      repository,
    );
    const members = await repository.listClassroomMembers(classroomId);
    const includeEmail = access.member.role === "owner";
    const memberViews = await Promise.all(
      members
        .filter((member) => member.status === "active")
        .map(async (member) =>
          safeMemberView(member, await repository.getUser(member.userId), includeEmail),
        ),
    );
    const teachers = memberViews.filter((member) => member.role === "owner" || member.role === "teacher");
    return jsonResponse(
      {
        classroom: safeClassroomView(access.classroom),
        role: access.member.role,
        members: access.member.role === "student" ? teachers : memberViews,
      },
      request,
    );
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const parsed = updateClassroomSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new ValidationError("classroom name is required");
    const classroom = await updateClassroomName(classroomId, user.id, parsed.data.name);
    return jsonResponse({ classroom: safeClassroomView(classroom) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
