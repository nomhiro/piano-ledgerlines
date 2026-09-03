import assert from "node:assert/strict";
import test from "node:test";
import { subscribeTakeEvents } from "./client";

test("falls back to polling when the progress stream disconnects", async () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;

  class DisconnectingEventSource {
    onerror: ((event: Event) => void) | null = null;

    constructor() {
      queueMicrotask(() => this.onerror?.(new Event("error")));
    }

    addEventListener() {}
    close() {}
  }

  globalThis.EventSource = DisconnectingEventSource as unknown as typeof EventSource;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "take_1",
    status: "completed",
    progress: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const status = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("subscription did not finish")), 1000);
      subscribeTakeEvents(
        "take_1",
        () => {},
        (data) => {
          clearTimeout(timeout);
          resolve(data.status);
        },
        reject,
      );
    });
    assert.equal(status, "completed");
  } finally {
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
  }
});
