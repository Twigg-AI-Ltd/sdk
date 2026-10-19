// The one place requests are sent: URL building, auth, per-attempt timeouts, retries, and turning
// error responses into TwiggError subclasses. Resources describe requests; they never fetch.
import { ConnectionError, errorFromResponse, TimeoutError, TwiggError } from "../errors.js";

/** Per-call overrides, accepted as the last argument of every SDK method. */
export interface RequestOptions {
  /** Cancels the request. The SDK rethrows the signal's reason, not a TwiggError. */
  signal?: AbortSignal;
  /** Milliseconds per attempt, overriding the client's `timeout`. */
  timeout?: number;
  /** Overrides the client's `maxRetries` for this call. */
  maxRetries?: number;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

export interface TransportConfig {
  apiKey: string | undefined;
  baseURL: string;
  timeout: number;
  maxRetries: number;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  headers: Record<string, string>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  /**
   * `required` fails before sending when there is no API key. `optional` sends the key when there
   * is one: the public catalogue then prices for the caller's organisation.
   */
  auth: "required" | "optional";
  /**
   * Whether repeating the request is harmless. Idempotent requests retry on network errors,
   * timeouts and 5xx; others retry only on 429, which the API returns before doing anything.
   */
  idempotent: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export class Transport {
  constructor(private readonly config: TransportConfig) {}

  /** Send a request and parse its JSON body. */
  async json<T>(request: ApiRequest, options?: RequestOptions): Promise<T> {
    const text = await this.text(request, options);
    return JSON.parse(text) as T;
  }

  /** Send a request whose success has no body worth reading (204, for instance). */
  async empty(request: ApiRequest, options?: RequestOptions): Promise<void> {
    await this.text(request, options);
  }

  /** Send a request and return its body as text. Retries and error mapping apply. */
  async text(request: ApiRequest, options: RequestOptions = {}): Promise<string> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(request, options, false);
      if (outcome.ok) return outcome.text;
      if (!shouldRetry(request, outcome.error, attempt, maxRetries)) throw outcome.error;
      await this.config.sleep(retryDelay(outcome.retryAfter, attempt), options.signal);
    }
  }

  /**
   * Open a streaming response: one attempt, no retries. The timeout covers the wait for headers
   * only; the caller owns the body and its idle timeout. Error statuses become TwiggErrors.
   */
  async open(request: ApiRequest, options: RequestOptions = {}): Promise<OpenOutcome> {
    return this.attempt(request, options, true);
  }

  /** Wait `ms` milliseconds, through the client's injectable sleep. */
  pause(ms: number, signal?: AbortSignal): Promise<void> {
    return this.config.sleep(ms, signal);
  }

  /** The wait before retry number `attempt + 1`, honouring Retry-After. */
  delay(retryAfter: string | null, attempt: number, signal?: AbortSignal): Promise<void> {
    return this.config.sleep(retryDelay(retryAfter, attempt), signal);
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    // encodeURIComponent leaves "." and ".." alone and URL parsing resolves them, so an id or
    // model name of ".." would send an authenticated request somewhere else. An empty segment
    // means a missing id.
    const segments = path === "/" ? [] : path.split("/").slice(1);
    if (segments.some((s) => s === "" || s === "." || s === ".."))
      throw new TypeError(`Invalid path ${JSON.stringify(path)}: empty, "." or ".." segment`);
    // Concatenated rather than resolved, so a base URL with a path prefix keeps it.
    const url = new URL(this.config.baseURL.replace(/\/+$/, "") + path);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async attempt(
    request: ApiRequest,
    options: RequestOptions,
    stream: false,
  ): Promise<{ ok: true; text: string } | Failure>;
  private async attempt(
    request: ApiRequest,
    options: RequestOptions,
    stream: true,
  ): Promise<OpenOutcome>;
  private async attempt(
    request: ApiRequest,
    options: RequestOptions,
    stream: boolean,
  ): Promise<{ ok: true; text: string } | OpenOutcome> {
    const headers: Record<string, string> = {
      Accept: stream ? "text/event-stream" : "application/json",
      ...this.config.headers,
      ...options.headers,
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    else if (request.auth === "required")
      throw new TwiggError("No API key. Pass apiKey to new Twigg() or set TWIGG_API_KEY.", {
        code: "missing_api_key",
      });
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    const url = this.url(request.path, request.query);

    // A timer rather than AbortSignal.timeout, so a stream can cancel it once headers arrive
    // instead of being cut off mid-turn.
    const ms = options.timeout ?? this.config.timeout;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ms);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    try {
      const response = await this.config.fetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal,
      });
      if (stream && response.ok) return { ok: true, response };
      // Read inside the attempt so the timeout covers a body that stalls, not just the headers.
      const text = await response.text();
      if (response.ok) return { ok: true, text };
      return {
        ok: false,
        error: errorFromResponse(response.status, response.statusText, text),
        retryAfter: response.headers.get("retry-after"),
      };
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.signal.aborted)
        return {
          ok: false,
          error: new TimeoutError(`No response within ${ms}ms`, { code: "timeout", cause }),
          retryAfter: null,
        };
      return {
        ok: false,
        error: new ConnectionError(cause instanceof Error ? cause.message : String(cause), {
          code: "connection_error",
          cause,
        }),
        retryAfter: null,
      };
    } finally {
      // On every path: a stream's body is no longer covered once its headers have arrived, and
      // a live timer would keep a short script's event loop open for the full timeout.
      clearTimeout(timer);
    }
  }
}

interface Failure {
  ok: false;
  error: TwiggError;
  retryAfter: string | null;
}
export type OpenOutcome = { ok: true; response: Response } | Failure;

/**
 * Whether a failed attempt may be repeated. 429 always: the API rejects before doing anything.
 * Network errors, timeouts and 5xx only when repeating the request is harmless.
 */
export function shouldRetry(
  request: Pick<ApiRequest, "idempotent">,
  error: TwiggError,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt >= maxRetries) return false;
  if (error.status === 429) return true;
  return (
    request.idempotent &&
    (error instanceof ConnectionError || RETRYABLE_STATUS.has(error.status ?? 0))
  );
}

/** Honour Retry-After when present, otherwise exponential backoff with full jitter. */
export function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return clamp(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return clamp(date - Date.now());
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function clamp(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_DELAY_MS);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build a path, percent-encoding each interpolated parameter: path`/chats/${id}`. */
export function path(strings: TemplateStringsArray, ...params: string[]): string {
  return strings.reduce(
    (built, part, i) =>
      built + part + (i < params.length ? encodeURIComponent(params[i] ?? "") : ""),
    "",
  );
}
