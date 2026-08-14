import { processStripeWebhook } from "@/lib/server/billing";
import { errorResponse, jsonResponse } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const result = await processStripeWebhook(
      rawBody,
      request.headers.get("stripe-signature"),
      getRepository(),
    );
    return jsonResponse(result, request);
  } catch (error) {
    return errorResponse(request, error, "Stripe webhook processing failed");
  }
}
