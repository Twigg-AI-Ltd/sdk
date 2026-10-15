// One error family for every failure: HTTP errors, network failures and (later) stream errors
// all carry the API's own `code`, `message`, `hint` and `details`.
import type { ErrorBody } from "./types.js";

export interface TwiggErrorInit {
  status?: number | undefined;
  code: string;
  hint?: string | null | undefined;
  details?: unknown;
  cause?: unknown;
}

export class TwiggError extends Error {
  override name = "TwiggError";
  /** HTTP status, when the API answered. `undefined` for network failures. */
  readonly status: number | undefined;
  /** The API's machine-readable code, such as `validation_error` or `not_found`. */
  readonly code: string;
  readonly hint: string | null;
  readonly details: unknown;

  constructor(message: string, init: TwiggErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.hint = init.hint ?? null;
    this.details = init.details;
  }
}

/** 400: the request was malformed. */
export class BadRequestError extends TwiggError {
  override name = "BadRequestError";
}
/** 401: missing or invalid API key. */
export class AuthenticationError extends TwiggError {
  override name = "AuthenticationError";
}
/** 402: the balance cannot pay for this request. */
export class InsufficientBalanceError extends TwiggError {
  override name = "InsufficientBalanceError";
}
/** 403: the key is valid but not allowed to do this. */
export class PermissionDeniedError extends TwiggError {
  override name = "PermissionDeniedError";
}
/** 404: no such resource in this organisation. */
export class NotFoundError extends TwiggError {
  override name = "NotFoundError";
}
/** 409: the chat is busy, the idempotency key was used, or there is nothing to abort. */
export class ConflictError extends TwiggError {
  override name = "ConflictError";
}
/**
 * 409: this idempotency key already started a run. The API does not replay that run's stream;
 * `responses.create` recovers its result instead, unless recovery is off.
 */
export class IdempotencyConflictError extends ConflictError {
  override name = "IdempotencyConflictError";
  /** The run the key already belongs to. */
  readonly originalRunId: string;

  constructor(message: string, init: TwiggErrorInit & { originalRunId: string }) {
    super(message, init);
    this.originalRunId = init.originalRunId;
  }
}
/** 413: the request body is over the size limit. */
export class PayloadTooLargeError extends TwiggError {
  override name = "PayloadTooLargeError";
}
/** 422: the request parsed but failed validation. `details` may say which field. */
export class ValidationError extends TwiggError {
  override name = "ValidationError";
}
/** 429: too many requests. Retried automatically. */
export class RateLimitError extends TwiggError {
  override name = "RateLimitError";
}
/** 500: an unexpected failure inside Twigg. */
export class InternalServerError extends TwiggError {
  override name = "InternalServerError";
}
/** 502: a model provider or other upstream failed. */
export class UpstreamError extends TwiggError {
  override name = "UpstreamError";
}
/** 503: Twigg is temporarily unavailable. */
export class ServiceUnavailableError extends TwiggError {
  override name = "ServiceUnavailableError";
}
/** The stream reported a failure after it opened, or the run it was recovering failed. */
export class StreamError extends TwiggError {
  override name = "StreamError";
  /** The run that failed, when the stream got far enough to name it. */
  readonly runId: string | undefined;

  constructor(message: string, init: TwiggErrorInit & { runId?: string | undefined }) {
    super(message, init);
    this.runId = init.runId;
  }
}
/** No response: DNS, TCP, TLS or a dropped connection. */
export class ConnectionError extends TwiggError {
  override name = "ConnectionError";
}
/** No response within the configured timeout. */
export class TimeoutError extends ConnectionError {
  override name = "TimeoutError";
}

const byStatus: Record<number, new (message: string, init: TwiggErrorInit) => TwiggError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: InsufficientBalanceError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitError,
  500: InternalServerError,
  502: UpstreamError,
  503: ServiceUnavailableError,
};

/** Build the right error class from an HTTP status and the response body text. */
export function errorFromResponse(status: number, statusText: string, text: string): TwiggError {
  const body = parseErrorBody(text);
  const Class = byStatus[status] ?? TwiggError;
  const originalRunId = status === 409 && body ? idempotentRun(body) : undefined;
  if (body && originalRunId)
    return new IdempotencyConflictError(body.message, {
      status,
      code: body.code,
      hint: body.hint,
      details: body.details,
      originalRunId,
    });
  if (body)
    return new Class(body.message, {
      status,
      code: body.code,
      hint: body.hint,
      details: body.details,
    });
  return new Class(text.trim() || statusText || `HTTP ${status}`, {
    status,
    code: `http_${status}`,
  });
}

/**
 * The run a replayed idempotency key belongs to. Read from `details.run_id` when the API sends
 * it, otherwise from the message: "idempotency key 'k' was already used; it belongs to run <id>".
 */
function idempotentRun(body: ErrorBody): string | undefined {
  const details = body.details as { run_id?: unknown } | null | undefined;
  if (typeof details?.run_id === "string") return details.run_id;
  return /idempotency key .* belongs to run ([0-9a-f-]{36})/i.exec(body.message)?.[1];
}

function parseErrorBody(text: string): ErrorBody | undefined {
  try {
    const error = (JSON.parse(text) as { error?: Partial<ErrorBody> }).error;
    if (error && typeof error.code === "string" && typeof error.message === "string")
      return error as ErrorBody;
  } catch {
    // Not the JSON envelope; a proxy or load balancer answered.
  }
  return undefined;
}
