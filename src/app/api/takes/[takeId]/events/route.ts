import { getTake } from "@/lib/server/repository";

export const runtime = "nodejs";

const POLL_INTERVAL_MS = 1000;
const MAX_DURATION_MS = 10 * 60 * 1000; // api.md 5.3: 接続は最大10分

// GET /api/takes/{takeId}/events — 進捗（SSE） (api.md 5.3 #17)
// ローカル実装ではリアルタイムのpub/subがないため、take.jsonをポーリングして
// SSEイベントに変換する。SSEが使えない環境向けに GET /api/takes/{takeId} の
// 3秒間隔ポーリングにも同じ status フィールドで対応できる。
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ takeId: string }> }
) {
  const { takeId } = await params;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const startedAt = Date.now();
      let closed = false;

      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const tick = async () => {
        if (closed) return;
        const take = await getTake(takeId);
        if (!take) {
          send("error", { message: "take not found" });
          controller.close();
          closed = true;
          return;
        }

        if (take.status === "completed" || take.status === "failed") {
          send("status", {
            status: take.status,
            progress: take.progress,
            scoresReady: take.status === "completed",
          });
          send("done", { status: take.status });
          controller.close();
          closed = true;
          return;
        }

        send("status", { status: take.status, progress: take.progress });

        if (Date.now() - startedAt > MAX_DURATION_MS) {
          controller.close();
          closed = true;
          return;
        }

        setTimeout(tick, POLL_INTERVAL_MS);
      };

      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
