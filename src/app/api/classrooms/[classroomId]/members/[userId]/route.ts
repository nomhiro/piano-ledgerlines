import { getAuthenticatedUser } from "@/lib/server/auth";
import { removeClassroomMember } from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; userId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, userId } = await params;
    return jsonResponse(
      await removeClassroomMember(classroomId, userId, user.id, getRepository()),
      request,
    );
  } catch (error) {
    return errorResponse(request, error);
  }
}
