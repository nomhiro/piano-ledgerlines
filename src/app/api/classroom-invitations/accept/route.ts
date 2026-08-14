import { getAuthenticatedUser } from "@/lib/server/auth";
import { acceptClassroomInvitation } from "@/lib/server/classroom-invitations";
import { errorResponse, jsonResponse, readJson } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";
import { parseSchema } from "@/lib/server/validation";
import { z } from "zod";

export const runtime = "nodejs";

const acceptSchema = z.object({
  classroomId: z.string().min(1).max(100),
  invitationId: z.string().min(1).max(100),
  secret: z.string().min(32).max(128),
}).strict();

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser(request);
    const input = parseSchema(acceptSchema, await readJson(request));
    return jsonResponse(await acceptClassroomInvitation(input, user, getRepository()), request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
