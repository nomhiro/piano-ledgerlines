import { getAuthenticatedUser } from "@/lib/server/auth";
import { reconcileClassroomBilling } from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const classroom = await reconcileClassroomBilling(classroomId, user.id, getRepository());
    return jsonResponse({ classroom }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
