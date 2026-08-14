import { getAuthenticatedUser } from "@/lib/server/auth";
import { requireActiveClassroomAccess, safeClassroomRosterMemberView } from "@/lib/server/classroom-access";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const repository = getRepository();
    const access = await requireActiveClassroomAccess(classroomId, user.id, ["owner", "teacher"], repository);
    const members = await repository.listClassroomMembers(classroomId);
    const views = await Promise.all(members.map(async (member) =>
      safeClassroomRosterMemberView(
        member,
        await repository.getUser(member.userId),
        access.member.role,
      ),
    ));
    return jsonResponse({ members: views }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
