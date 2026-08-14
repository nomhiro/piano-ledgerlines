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

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "you do not have permission to perform this action") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  constructor(message = "too many requests", retryAfterSeconds = 60) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ConfigurationError extends Error {
  readonly status = 503;
  constructor(message = "billing is not configured") {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class BillingInProgressError extends Error {
  readonly status = 503;
  constructor(message = "billing operation is already in progress") {
    super(message);
    this.name = "BillingInProgressError";
  }
}

export function requestOperationKey(request: Request): string {
  const value = request.headers.get("idempotency-key") ?? request.headers.get("x-request-id");
  if (!value) return randomUUID();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new ValidationError("Idempotency-Key must be 1-128 printable ASCII characters");
  }
  return trimmed;
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
          : error instanceof ForbiddenError
            ? 403
              : error instanceof ConflictError
                ? 409
                : error instanceof RateLimitError
                  ? 429
              : error instanceof ConfigurationError
              ? 503
              : error instanceof BillingInProgressError
                ? 503
          : 500;
  const code = error instanceof AuthError
    ? "UNAUTHENTICATED"
    : error instanceof ValidationError
      ? "VALIDATION_FAILED"
      : error instanceof NotFoundError
        ? "NOT_FOUND"
        : error instanceof QuotaExceededError
          ? "QUOTA_EXCEEDED"
          : error instanceof ForbiddenError
            ? "FORBIDDEN"
            : error instanceof ConflictError
              ? "CONFLICT"
              : error instanceof RateLimitError
                ? "RATE_LIMITED"
            : error instanceof ConfigurationError
              ? "CONFIGURATION_ERROR"
              : error instanceof BillingInProgressError
                ? "BILLING_IN_PROGRESS"
          : "INTERNAL";
  const message = status === 500 ? fallbackMessage : error instanceof Error ? error.message : fallbackMessage;
  const responseHeaders: Record<string, string> = {
    "X-Request-Id": id,
    "X-Api-Version": "1",
  };
  if (error instanceof RateLimitError) {
    responseHeaders["Retry-After"] = String(error.retryAfterSeconds);
  }
  return NextResponse.json(
    { error: { code, message, requestId: id, retryable: status >= 500 } },
    { status, headers: responseHeaders }
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
