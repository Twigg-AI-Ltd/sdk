// Reading a turn that a server forwarded with `stream.toResponse()`. Runs in the browser with no
// API key and makes no requests of its own; it only parses and accumulates.
import { StreamError } from "./errors.js";
import type { StreamEvent } from "./streaming/response-stream.js";
import { ResponseAccumulator, type ResponseResult, type ToolCall } from "./streaming/result.js";
import { parseSse } from "./streaming/sse.js";
import type { ResponseEvent } from "./types.js";

export interface ForwardedListeners {
  event: (event: StreamEvent) => void;
  text: (delta: string, snapshot: string) => void;
  reasoning: (delta: string, snapshot: string) => void;
  toolCall: (call: ToolCall) => void;
}

/**
 * A forwarded turn: iterate its events, listen for text as it arrives, or await `final()`.
 *
 *   const turn = readForwardedStream(await fetch("/api/chat", { method: "POST", body }));
 *   turn.on("text", (_, all) => render(all));
 *   const result = await turn.final();
 */
export class ForwardedStream implements AsyncIterable<StreamEvent> {
  private readonly accumulator = new ResponseAccumulator();
  private readonly listeners: { [K in keyof ForwardedListeners]: ForwardedListeners[K][] } = {
    event: [],
    text: [],
    reasoning: [],
    toolCall: [],
  };
  private readonly events: StreamEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: unknown;
  private started: Promise<ResponseResult> | undefined;
  private recovered: ResponseResult | undefined;
  private snapshots = { text: "", reasoning: "" };

  constructor(private readonly body: ReadableStream<Uint8Array>) {}

  on<K extends keyof ForwardedListeners>(name: K, listener: ForwardedListeners[K]): this {
    this.listeners[name].push(listener);
    return this;
  }

  /** Alias of `final()`, named as in the OpenAI SDK. */
  finalResponse(): Promise<ResponseResult> {
    return this.final();
  }

  final(): Promise<ResponseResult> {
    this.started ??= this.read().then(
      (result) => {
        this.finish(undefined);
        return result;
      },
      (error: unknown) => {
        this.finish(error);
        throw error;
      },
    );
    return this.started;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    void this.final().catch(() => {});
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
  }

  private async read(): Promise<ResponseResult> {
    for await (const frame of parseSse(this.body)) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        continue;
      }
      const event = { event: frame.event, data } as StreamEvent;
      if (event.event === "recovered") this.recovered = event.data;
      else {
        const completed = this.accumulator.push(event as ResponseEvent);
        if (
          event.event === "delta" &&
          (event.data.kind === "text" || event.data.kind === "reasoning")
        ) {
          const kind = event.data.kind;
          this.snapshots[kind] += event.data.text;
          for (const listener of this.listeners[kind])
            listener(event.data.text, this.snapshots[kind]);
        }
        if (completed) for (const listener of this.listeners.toolCall) listener(completed);
      }
      this.events.push(event);
      for (const listener of this.listeners.event) listener(event);
      this.wake?.();
      this.wake = undefined;
    }
    if (this.recovered) return this.recovered;
    if (this.accumulator.done) return this.accumulator.result();
    const error = this.accumulator.error;
    if (error)
      throw new StreamError(error.message, {
        code: error.code,
        hint: error.hint,
        details: error.details,
        runId: this.accumulator.runId,
      });
    throw new StreamError("The stream ended before the turn finished", {
      code: "stream_interrupted",
      runId: this.accumulator.runId,
    });
  }

  private finish(failure: unknown): void {
    this.ended = true;
    this.failure = failure;
    this.wake?.();
    this.wake = undefined;
  }
}

/** Read a forwarded turn from a fetch Response or its body. */
export function readForwardedStream(
  source: Response | ReadableStream<Uint8Array>,
): ForwardedStream {
  const body = source instanceof Response ? source.body : source;
  if (!body) throw new TypeError("The response has no body to read");
  return new ForwardedStream(body);
}

export { StreamError } from "./errors.js";
export type { StreamEvent } from "./streaming/response-stream.js";
export type { Block, ResponseResult, ToolCall, TwiggWarning } from "./streaming/result.js";
