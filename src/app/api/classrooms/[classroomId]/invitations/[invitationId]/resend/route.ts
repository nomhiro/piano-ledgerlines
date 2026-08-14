import { getAuthenticatedUser } from "@/lib/server/auth";
import { resendClassroomInvitation } from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classroomId: string; invitationId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId, invitationId } = await params;
    return jsonResponse(
      await resendClassroomInvitation(classroomId, invitationId, user.id, getRepository()),
      request,
    );
  } catch (error) {
    return errorResponse(request, error);
  }
}
