// One turn's stream. Starts on first use, buffers every event so any number of consumers see the
// whole turn, and turns a dropped connection into a recovered result instead of an error.

import { type RequestOptions, shouldRetry, type Transport } from "../core/transport.js";
import {
  ConflictError,
  ConnectionError,
  IdempotencyConflictError,
  StreamError,
  type TwiggError,
} from "../errors.js";
import type {
  ChatId,
  CompactingData,
  CreateResponseRequest,
  ResponseEvent,
  RunId,
} from "../types.js";
import { type RecoveryDeps, recoverResult } from "./recovery.js";
import {
  ResponseAccumulator,
  type ResponseResult,
  type ToolCall,
  type TwiggWarning,
} from "./result.js";
import { formatSse, IdleTimeout, parseSse } from "./sse.js";

export interface StreamOptions extends RequestOptions {
  /**
   * Rebuild the result from the run and chat history when the connection drops mid-turn.
   * Default true.
   */
  recover?: boolean;
  /** Milliseconds without a byte before the connection counts as dropped. Default 300 000. */
  idleTimeout?: number;
  /** How long recovery waits for the run to finish. Default 600 000. */
  recoveryTimeout?: number;
  /**
   * When `signal` aborts, also stop the turn on the server. By default aborting only detaches:
   * the turn carries on and its output lands in history.
   */
  abortRun?: boolean;
}

export interface ForwardOptions {
  /**
   * Which events reach the browser.
   *
   * `"content"` (default) sends what a chat UI renders: the run's ids, blocks and deltas,
   * compaction notices, and `done` without its cost. Configuration and translation warnings stay
   * on the server, since they can name other namespaces and provider keys, and errors carry
   * their code with a generic message. `"all"` forwards every event as received.
   */
  events?: "content" | "all";
}

/** An event as `toReadableStream()` forwards it by default, or undefined to withhold it. */
function forClient(event: StreamEvent): StreamEvent | undefined {
  switch (event.event) {
    case "config_warnings":
    case "translation_warnings":
      return undefined;
    case "done":
      return { ...event, data: { ...event.data, cost: null, provider_response_id: null } };
    case "error":
      return { ...event, data: { code: event.data.code, message: "The turn failed" } };
    case "recovered":
      return {
        ...event,
        data: { ...event.data, cost: null, providerResponseId: null, warnings: [] },
      };
    default:
      return event;
  }
}

/** Every stream event, plus `recovered` when the result was rebuilt after a dropped connection. */
export type StreamEvent = ResponseEvent | { event: "recovered"; data: ResponseResult };

export interface StreamListeners {
  /** Any event, in order. */
  event: (event: StreamEvent) => void;
  /** A text delta, and all text so far. */
  text: (delta: string, snapshot: string) => void;
  reasoning: (delta: string, snapshot: string) => void;
  refusal: (delta: string, snapshot: string) => void;
  /** A tool call whose arguments have fully arrived. */
  toolCall: (call: ToolCall) => void;
  warning: (warning: TwiggWarning) => void;
  /** The turn is waiting for history to be compacted. */
  compacting: (data: CompactingData) => void;
  done: (result: ResponseResult) => void;
  error: (error: unknown) => void;
}

export interface StreamDeps extends RecoveryDeps {
  transport: Transport;
  /** Stop a run on the server. */
  abortRun: (chatId: ChatId, runId: RunId) => Promise<unknown>;
  onWarning: ((warning: TwiggWarning) => void) | undefined;
  maxRetries: number;
}

type Listener = (...args: never[]) => void;

export class ResponseStream implements AsyncIterable<StreamEvent> {
  private readonly accumulator = new ResponseAccumulator();
  private readonly events: StreamEvent[] = [];
  private readonly listeners = new Map<keyof StreamListeners, Listener[]>();
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: unknown;
  private started: Promise<ResponseResult> | undefined;
  private readonly runIdKnown: Promise<RunId>;
  private resolveRunId!: (runId: RunId) => void;
  private rejectRunId!: (error: unknown) => void;
  private aborting: Promise<void> | undefined;
  /** Detaches this client: fires on close(), and on the caller's signal. */
  private readonly closer = new AbortController();
  private closed = false;
  private finalRequested = false;
  private iterating = 0;
  /** The first error a listener threw while the turn was streaming. */
  private listenerError: { error: unknown } | undefined;
  private snapshots = { text: "", reasoning: "", refusal: "" };

  constructor(
    private readonly deps: StreamDeps,
    private readonly chatId: ChatId,
    private readonly body: CreateResponseRequest,
    private readonly options: StreamOptions = {},
  ) {
    this.runIdKnown = new Promise((resolve, reject) => {
      this.resolveRunId = resolve;
      this.rejectRunId = reject;
    });
    // Observed here so a stream that fails before naming its run is never an unhandled rejection.
    this.runIdKnown.catch(() => {});
  }

  /** The run's id, as soon as the stream names it. Starts the stream. */
  get runId(): Promise<RunId> {
    // Failures surface through final() and iteration; never as an unhandled rejection here.
    void this.start().catch(() => {});
    return this.runIdKnown;
  }

  /** Register a listener. Listeners added before the stream starts see every event. */
  on<K extends keyof StreamListeners>(name: K, listener: StreamListeners[K]): this {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as Listener);
    this.listeners.set(name, list);
    return this;
  }

  /** The finished result. Starts the stream and consumes it if nothing else is. */
  final(): Promise<ResponseResult> {
    this.finalRequested = true;
    return this.start();
  }

  /** Alias of `final()`, named as in the OpenAI SDK. */
  finalResponse(): Promise<ResponseResult> {
    return this.final();
  }

  /**
   * Stop the turn on the server. The stream carries on and ends with `stop_reason: "aborted"`,
   * unless the turn finished first. Waits for the run to be named if it has not been yet. Does
   * nothing for a stream that never started or has already ended.
   */
  abort(): Promise<void> {
    if (this.aborting) return this.aborting; // One request however many times this is called.
    if (!this.started || this.ended) return Promise.resolve();
    this.aborting = this.runIdKnown.then(
      async (runId) => {
        if (this.ended) return;
        try {
          await this.deps.abortRun(this.chatId, runId);
        } catch (error) {
          // 409: the turn finished before the abort arrived, so there is nothing to stop.
          if (!(error instanceof ConflictError)) throw error;
        }
      },
      () => {}, // The stream failed, so there is no turn left to stop.
    );
    // A caller awaiting abort() still sees a failure, but one that nobody awaits (the usual
    // `setTimeout(() => stream.abort())`) is never an unhandled rejection.
    this.aborting.catch(() => {});
    return this.aborting;
  }

  /**
   * Stop reading and release the connection. The turn carries on on Twigg and its output lands
   * in history; use abort() to stop it. `final()` and iteration then fail with code `closed`.
   * Leaving a `for await` loop early closes the stream when nothing else is consuming it.
   */
  close(): void {
    if (this.ended || this.closed) return;
    this.closed = true;
    const reason = new StreamError("The stream was closed before the turn finished", {
      code: "closed",
    });
    this.closer.abort(reason);
    if (!this.started) {
      this.started = Promise.reject(reason);
      this.started.catch(() => {});
      this.rejectRunId(reason);
      this.finish(reason);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    void this.start().catch(() => {});
    this.iterating++;
    try {
      for (let i = 0; ; ) {
        if (i < this.events.length) {
          // biome-ignore lint/style/noNonNullAssertion: bounds checked above.
          yield this.events[i++]!;
          continue;
        }
        if (this.ended) {
          if (this.failure !== undefined) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => {
          const previous = this.wake;
          this.wake = () => {
            previous?.();
            resolve();
          };
        });
      }
    } finally {
      this.iterating--;
      // Left early (`break`): release the connection unless someone else still wants the turn.
      if (!this.ended) this.closeIfUnused();
    }
  }

  private closeIfUnused(): void {
    if (this.iterating === 0 && !this.finalRequested) this.close();
  }

  /**
   * The stream as server-sent events, for forwarding to a browser. Failures become an `error`
   * event, and a recovered turn ends with a `recovered` event carrying the result. By default
   * only what a chat UI renders is sent; see {@link ForwardOptions}.
   */
  toReadableStream(options: ForwardOptions = {}): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = this[Symbol.asyncIterator]();
    const events = this.events;
    const all = options.events === "all";
    return new ReadableStream({
      async pull(controller) {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return controller.close();
            const event = all ? next.value : forClient(next.value);
            if (!event) continue; // Withheld; read on so pull() always delivers or closes.
            return controller.enqueue(encoder.encode(formatSse(event.event, event.data)));
          }
        } catch (error) {
          // A server `error` event was already forwarded; anything else gets one here.
          if (events.at(-1)?.event !== "error") {
            const code = (error as Partial<TwiggError>).code ?? "stream_failed";
            const message = all && error instanceof Error ? error.message : "The turn failed";
            controller.enqueue(encoder.encode(formatSse("error", { code, message })));
          }
          controller.close();
        }
      },
      cancel: () => {
        // The browser went away. Not awaited: return() would wait behind the pending next()
        // until the next event, so close first to end the wait.
        if (this.iterating <= 1 && !this.finalRequested) this.close();
        void iterator.return(undefined);
      },
    });
  }

  /** A `Response` streaming this turn as server-sent events, for route handlers. */
  toResponse(init: ResponseInit = {}, options: ForwardOptions = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("cache-control", "no-cache");
    return new Response(this.toReadableStream(options), { ...init, headers });
  }

  private start(): Promise<ResponseResult> {
    this.started ??= this.run().then(
      (result) => {
        this.finish(undefined);
        this.callAfterEnd("done", result);
        return result;
      },
      (error: unknown) => {
        this.rejectRunId(error);
        this.finish(error);
        if (!this.closed) this.callAfterEnd("error", error);
        throw error;
      },
    );
    return this.started;
  }

  private async run(): Promise<ResponseResult> {
    const { transport, maxRetries } = this.deps;
    const caller = this.options.signal;
    const signal = caller ? AbortSignal.any([caller, this.closer.signal]) : this.closer.signal;
    const options = { ...this.options, signal };
    const body = {
      ...this.body,
      idempotency_key: this.body.idempotency_key ?? crypto.randomUUID(),
    };
    const request = {
      method: "POST" as const,
      path: `/api/v1/chats/${encodeURIComponent(this.chatId)}/responses`,
      body,
      auth: "required" as const,
      // Safe to repeat: the idempotency key turns a duplicate into a 409 naming the first run.
      idempotent: true,
    };
    // The run may be named after the signal fires, or only through a 409, so wait for it.
    const onAbort = () => {
      if (options.abortRun)
        void this.runIdKnown
          .then((runId) => this.deps.abortRun(this.chatId, runId))
          .catch(() => {});
    };
    caller?.addEventListener("abort", onAbort, { once: true });
    try {
      for (let attempt = 0; ; attempt++) {
        const outcome = await transport.open(request, options);
        if (!outcome.ok) {
          const error = outcome.error;
          if (error instanceof IdempotencyConflictError && options.recover !== false)
            return await this.recover(error.originalRunId, options);
          if (!shouldRetry(request, error, attempt, options.maxRetries ?? maxRetries)) throw error;
          await transport.delay(outcome.retryAfter, attempt, options.signal);
          continue;
        }

        const dropped = await this.read(outcome.response, signal);
        if (this.listenerError) throw this.listenerError.error;
        if (this.accumulator.done) return this.accumulator.result();
        if (this.accumulator.error)
          throw new StreamError(this.accumulator.error.message, {
            code: this.accumulator.error.code,
            hint: this.accumulator.error.hint,
            details: this.accumulator.error.details,
            runId: this.accumulator.runId,
          });

        const runId = this.accumulator.runId;
        if (runId && options.recover !== false) return await this.recover(runId, options);
        // Dropped before the run was named: it may or may not have started. Submitting again
        // with the same key either starts it or answers 409 with the run to recover.
        if (!runId && attempt < (options.maxRetries ?? maxRetries)) {
          await transport.delay(null, attempt, options.signal);
          continue;
        }
        throw new ConnectionError(`The stream ended before the turn finished: ${dropped}`, {
          code: "stream_interrupted",
        });
      }
    } finally {
      caller?.removeEventListener("abort", onAbort);
    }
  }

  /** Read events until the turn ends or the connection drops; returns why it dropped. */
  private async read(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) return "the response had no body";
    try {
      const frames = parseSse(response.body, this.options.idleTimeout ?? 300_000, signal);
      for await (const frame of frames) {
        let data: unknown;
        try {
          data = JSON.parse(frame.data);
        } catch {
          continue; // Not a Twigg event.
        }
        this.emit({ event: frame.event, data } as ResponseEvent);
        // A listener threw: stop reading and let run() report it as the stream's failure.
        if (this.accumulator.finished || this.listenerError) return "";
      }
      return "the connection closed";
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return error instanceof IdleTimeout ? error.message : String(error);
    }
  }

  private async recover(runId: RunId, options: StreamOptions): Promise<ResponseResult> {
    this.resolveRunId(runId);
    const result = await recoverResult(
      this.deps,
      this.chatId,
      runId,
      this.accumulator,
      this.options.recoveryTimeout ?? 600_000,
      options,
    );
    this.publish({ event: "recovered", data: result });
    return result;
  }

  private emit(event: ResponseEvent): void {
    const known = this.accumulator.warnings.length;
    const completed = this.accumulator.push(event);
    this.publish(event);
    switch (event.event) {
      case "run":
        this.resolveRunId(event.data.run_id);
        break;
      case "config_warnings":
      case "translation_warnings":
        // Warnings may repeat after compaction; the accumulator keeps each once.
        for (const warning of this.accumulator.warnings.slice(known)) {
          this.guard(() => this.deps.onWarning?.(warning));
          this.call("warning", warning);
        }
        break;
      case "compacting":
        this.call("compacting", event.data);
        break;
      case "delta":
        if (event.data.kind !== "tool_input") {
          const kind = event.data.kind;
          this.snapshots[kind] += event.data.text;
          this.call(kind, event.data.text, this.snapshots[kind]);
        }
        break;
    }
    if (completed) this.call("toolCall", completed);
  }

  private publish(event: StreamEvent): void {
    this.events.push(event);
    this.call("event", event);
    this.notify();
  }

  private finish(failure: unknown): void {
    this.ended = true;
    this.failure = failure;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private call<K extends keyof StreamListeners>(
    name: K,
    ...args: Parameters<StreamListeners[K]>
  ): void {
    for (const listener of this.listeners.get(name) ?? [])
      this.guard(() => (listener as (...a: unknown[]) => void)(...args));
  }

  /** Run listener code, keeping its first error to fail the stream with. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.listenerError ??= { error };
    }
  }

  /**
   * Call `done` or `error` listeners. The stream has already settled, so a throw cannot fail it;
   * it is rethrown on its own like an EventEmitter listener's, instead of vanishing.
   */
  private callAfterEnd(name: "done" | "error", value: unknown): void {
    for (const listener of this.listeners.get(name) ?? [])
      try {
        (listener as (v: unknown) => void)(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
  }
}
