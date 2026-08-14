import { getAuthenticatedUser } from "@/lib/server/auth";
import { createDraftClassroom } from "@/lib/server/billing";
import { errorResponse, readJson, ValidationError, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";
import { z } from "zod";

export const runtime = "nodejs";

const createClassroomSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser(request);
    const parsed = createClassroomSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new ValidationError("classroom name is required");
    const classroom = await createDraftClassroom(user.id, parsed.data, getRepository());
    return jsonResponse({ classroom }, request, { status: 201 });
  } catch (error) {
    return errorResponse(request, error);
  }
}
