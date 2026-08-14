import { getAuthenticatedUser } from "@/lib/server/auth";
import { createClassroomBillingPortal } from "@/lib/server/billing";
import { errorResponse, jsonResponse, requestOperationKey } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const result = await createClassroomBillingPortal(
      classroomId,
      user.id,
      getRepository(),
      undefined,
      requestOperationKey(request),
    );
    return jsonResponse(result, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
