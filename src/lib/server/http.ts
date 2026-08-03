import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthError } from "./auth";

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class QuotaExceededError extends Error {
  readonly status = 402;
  constructor(message = "monthly take quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export function requestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
}

export function errorResponse(
  request: Request,
  error: unknown,
  fallbackMessage = "request failed"
): NextResponse {
  const id = requestId(request);
  const status = error instanceof AuthError
    ? error.status
    : error instanceof ValidationError
      ? 400
      : error instanceof NotFoundError
        ? 404
        : error instanceof QuotaExceededError
          ? 402
          : 500;
  const code = error instanceof AuthError
    ? "UNAUTHENTICATED"
    : error instanceof ValidationError
      ? "VALIDATION_FAILED"
      : error instanceof NotFoundError
        ? "NOT_FOUND"
        : error instanceof QuotaExceededError
          ? "QUOTA_EXCEEDED"
          : "INTERNAL";
  const message = status === 500 ? fallbackMessage : error instanceof Error ? error.message : fallbackMessage;
  return NextResponse.json(
    { error: { code, message, requestId: id, retryable: status >= 500 } },
    { status, headers: { "X-Request-Id": id, "X-Api-Version": "1" } }
  );
}

export function jsonResponse(body: unknown, request: Request, init?: ResponseInit): NextResponse {
  const id = requestId(request);
  const headers = new Headers(init?.headers);
  headers.set("X-Request-Id", id);
  headers.set("X-Api-Version", "1");
  return NextResponse.json(body, { ...init, headers });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
}
