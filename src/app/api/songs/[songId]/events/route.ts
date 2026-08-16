import { getAuthenticatedUser } from "@/lib/server/auth";
import { errorResponse, requestId, NotFoundError } from "@/lib/server/http";
import { assertResourceId } from "@/lib/server/validation";
import { getSong } from "@/lib/server/repository";
import { isScoreProgressTerminal, scoreProgressFailureMessage } from "@/lib/score-progress";

export const runtime = "nodejs";

// takes/[takeId]/events/route.ts と同じ形。
//
// これは真の push ではない ── サーバー側で1秒ごとに曲ドキュメントを読み、その結果を
// SSE として流している。したがって Cosmos の読み取り回数はクライアントポーリングと
// 同じで、削減はしていない。利点は「クライアントが1接続で待てる」ことだけである。
// 真の push にするには Cosmos change feed に加えてブラウザへの配信経路
// (Web PubSub / SignalR) が必要になる。今の規模（登録は1回数秒〜数分、同時待機は
// ごく少数）では過剰と判断した（設計 §4.5）。
const POLL_INTERVAL_MS = 1000;
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ songId: string }> }
) {
  try {
    const { songId } = await params;
    assertResourceId(songId, "songId");
    const user = await getAuthenticatedUser(request);
    if (!(await getSong(songId, user.id))) throw new NotFoundError("song not found");
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
            const song = await getSong(songId, user.id);
            if (!song) {
              send("error", { code: "NOT_FOUND", message: "song not found" });
              controller.close(); closed = true; return;
            }
            send("status", {
              status: song.status,
              measureCount: song.measureCount,
              scoreMeasureCount: song.scoreMeasureCount,
              keySignature: song.keySignature,
              timeSignature: song.timeSignature,
              detectedTempo: song.detectedTempo,
              warnings: song.warnings,
              failureMessage: scoreProgressFailureMessage(song),
            });
            if (isScoreProgressTerminal(song.status) || Date.now() - startedAt > MAX_DURATION_MS) {
              send("done", { status: song.status });
              controller.close(); closed = true; return;
            }
            setTimeout(tick, POLL_INTERVAL_MS);
          } catch {
            send("error", { code: "INTERNAL", message: "unable to read score progress" });
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
