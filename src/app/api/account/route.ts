import { getAccountContext } from "@/lib/server/account";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, jsonResponse } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await getAuthenticatedUser(request);
    return jsonResponse({ account: await getAccountContext(user) }, request);
  } catch (error) {
    return errorResponse(request, error);
  }
}
