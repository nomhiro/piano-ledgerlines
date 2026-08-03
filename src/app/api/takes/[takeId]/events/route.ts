import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, requestId, NotFoundError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getTake } from "@/lib/server/repository";

export const runtime = "nodejs";

const POLL_INTERVAL_MS = 1000;
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  try {
    const { takeId } = await params;
    assertResourceId(takeId, "takeId");
    const user = await getAuthenticatedUser(request);
    if (!(await getTake(takeId, user.id))) throw new NotFoundError("take not found");
    const lastEvent = Number(request.headers.get("last-event-id") ?? "0");
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const startedAt = Date.now();
        let eventId = Number.isFinite(lastEvent) ? lastEvent : 0;
        let closed = false;
        const send = (event: string, data: unknown) => {
          eventId += 1;
          controller.enqueue(encoder.encode(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const tick = async () => {
          if (closed) return;
          try {
            const take = await getTake(takeId, user.id);
            if (!take) {
              send("error", { code: "NOT_FOUND", message: "take not found" });
              controller.close(); closed = true; return;
            }
            send("status", {
              status: take.status, progress: take.progress, scoresReady: take.status === "completed",
            });
            if (take.status === "completed" || take.status === "failed" || Date.now() - startedAt > MAX_DURATION_MS) {
              send("done", { status: take.status });
              controller.close(); closed = true; return;
            }
            setTimeout(tick, POLL_INTERVAL_MS);
          } catch {
            send("error", { code: "INTERNAL", message: "unable to read progress" });
            controller.close(); closed = true;
          }
        };
        await tick();
      },
    });
    const id = requestId(request);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive", "X-Request-Id": id, "X-Api-Version": "1",
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
