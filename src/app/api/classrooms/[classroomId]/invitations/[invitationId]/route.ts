import { getAuthenticatedUser } from "@/lib/server/auth";
import { revokeClassroomInvitation } from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; invitationId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, invitationId } = await params;
    await revokeClassroomInvitation(classroomId, invitationId, user.id, getRepository());
    return jsonResponse({ revoked: true }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
