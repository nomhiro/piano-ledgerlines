import { getConfig } from "./config";

export interface TelemetryEvent {
  name: string;
  timestamp?: string;
  correlationId?: string;
  jobId?: string;
  takeId?: string;
  songId?: string;
  stage?: string;
  durationMs?: number;
  failureCode?: string;
  queueDelayMs?: number;
  cosmosRu?: number;
  attributes?: Record<string, unknown>;
}

export interface TelemetrySink {
  record(event: TelemetryEvent): void;
  metric(name: string, value: number, tags?: Record<string, string>): void;
}

const sensitiveKey = /authorization|cookie|password|secret|token|sas|signature|credential|stripe|audio|memo|title|composer|email|displayName|userName|prompt|content/i;
const jwt = /\b(?:eyJ|bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

function redactValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.replace(jwt, "[REDACTED]").replace(/([?&](?:sig|se|sp|st|sv|sr)=)[^&\s]+/gi, "$1[REDACTED]").slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)])
    );
  }
  return value;
}

/** Redacts secrets, user text, and storage credentials before telemetry export. */
export function redactTelemetry<T>(value: T): T {
  return redactValue(value) as T;
}

class NoopTelemetry implements TelemetrySink {
  record(): void {}
  metric(): void {}
}

class ConsoleTelemetry implements TelemetrySink {
  record(event: TelemetryEvent): void {
    // This sink is intentionally opt-in and still applies the same redaction.
    console.info(JSON.stringify(redactTelemetry({ ...event, timestamp: event.timestamp ?? new Date().toISOString() })));
  }

  metric(name: string, value: number, tags?: Record<string, string>): void {
    this.record({ name: "metric", attributes: { metricName: name, value, tags } });
  }
}

let sink: TelemetrySink | undefined;

export function getTelemetry(): TelemetrySink {
  sink ??= getConfig().telemetryBackend === "console" ? new ConsoleTelemetry() : new NoopTelemetry();
  return sink;
}

export function resetTelemetryForTests(): void {
  sink = undefined;
}

export async function withTelemetry<T>(
  event: Omit<TelemetryEvent, "durationMs">,
  operation: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const result = await operation();
    const durationMs = Date.now() - started;
    getTelemetry().record({ ...event, durationMs });
    getTelemetry().metric(`${event.name}.duration_ms`, durationMs, event.stage ? { stage: event.stage } : undefined);
    return result;
  } catch (error) {
    const durationMs = Date.now() - started;
    getTelemetry().record({
      ...event,
      durationMs,
      failureCode: error instanceof Error ? error.name : "UNKNOWN",
    });
    getTelemetry().metric(`${event.name}.duration_ms`, durationMs, event.stage ? { stage: event.stage } : undefined);
    throw error;
  }
}
