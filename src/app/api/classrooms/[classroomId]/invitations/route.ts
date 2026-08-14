import { getAuthenticatedUser } from "@/lib/server/auth";
import {
  createClassroomInvitation,
  listClassroomInvitations,
} from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse, readJson } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";
import { parseSchema } from "@/lib/server/validation";
import { z } from "zod";

export const runtime = "nodejs";

const createInvitationSchema = z.object({
  email: z.string().trim().min(3).max(320),
  role: z.enum(["teacher", "student"]),
}).strict();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    return jsonResponse({ invitations: await listClassroomInvitations(classroomId, user.id, getRepository()) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request);
    const { classroomId } = await params;
    const input = parseSchema(createInvitationSchema, await readJson(request));
    return jsonResponse(
      await createClassroomInvitation(classroomId, user, input, getRepository()),
      request,
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(request, error);
  }
}
