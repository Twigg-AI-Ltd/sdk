// Build response streams for tests without a network: the events, their SSE text, or a Response.
import { formatSse } from "../streaming/sse.js";
import type { ConfigWarning, ResponseEvent, StopReason, Usage } from "../types.js";

type Done = Extract<ResponseEvent, { event: "done" }>["data"];

let counter = 0;
/** A UUID-shaped id that is unique within a test run and readable in failures. */
export function fakeId(prefix: number): string {
  counter += 1;
  return `00000000-0000-7000-${String(prefix).padStart(4, "0")}-${String(counter).padStart(12, "0")}`;
}

export interface RunInfo {
  runId?: string;
  chatId?: string;
  closedToolCalls?: string[];
}

export interface DoneInfo {
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  cost?: string | null;
  modelServed?: string | null;
}

/**
 * A fluent builder for one turn's stream. The `run` event comes first automatically, and
 * `done` lists every tool call as pending unless told otherwise.
 *
 *   streamBuilder().text("Let me look.").toolCall("read_file", { path: "a.txt" }).done()
 */
export class StreamBuilder {
  readonly runId: string;
  readonly chatId: string;
  private readonly events: ResponseEvent[] = [];
  private readonly calls: { tool_use_id: string; tool_name: string }[] = [];
  /** Set by `disconnectAfter`: how many events reach the client before the connection drops. */
  dropAfter: number | undefined;

  constructor(run: RunInfo = {}) {
    this.runId = run.runId ?? fakeId(1);
    this.chatId = run.chatId ?? fakeId(2);
    this.events.push({
      event: "run",
      data: {
        run_id: this.runId,
        chat_id: this.chatId,
        closed_tool_calls: run.closedToolCalls ?? [],
      },
    });
  }

  warning(warning: ConfigWarning): this {
    this.events.push({ event: "config_warnings", data: { warnings: [warning] } });
    return this;
  }

  compacting(blocks = 1): this {
    this.events.push({ event: "compacting", data: { blocks, in_progress_elsewhere: 0 } });
    return this;
  }

  /** A text block. Several strings become several deltas. */
  text(...deltas: string[]): this {
    return this.block("text", deltas);
  }

  reasoning(...deltas: string[]): this {
    return this.block("reasoning", deltas);
  }

  refusal(...deltas: string[]): this {
    return this.block("refusal", deltas);
  }

  /** A tool call. `input` is sent as JSON, or verbatim when it is a string. */
  toolCall(name: string, input: unknown = {}, id: string = `toolu_${fakeId(3).slice(-6)}`): this {
    this.calls.push({ tool_use_id: id, tool_name: name });
    this.events.push({
      event: "block_start",
      data: { kind: "tool_call", tool_use_id: id, tool_name: name },
    });
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    this.events.push({ event: "delta", data: { kind: "tool_input", text: raw } });
    this.events.push({ event: "block_stop", data: {} });
    return this;
  }

  /** End the turn successfully. Defaults to `tool_use` when tools were called. */
  done(info: DoneInfo = {}): this {
    const stopReason = info.stopReason ?? (this.calls.length > 0 ? "tool_use" : "end_turn");
    const data: Done = {
      compaction: null,
      cost: info.cost === undefined ? "0.0001" : info.cost,
      cost_currency: "USD",
      model_served: info.modelServed ?? "test-model",
      pending_tool_calls: stopReason === "tool_use" ? this.calls : [],
      provider_response_id: null,
      server_tools: null,
      stop_reason: stopReason,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        ...info.usage,
      },
    };
    this.events.push({ event: "done", data });
    return this;
  }

  /** End the turn with a failure. */
  error(code: string, message: string): this {
    this.events.push({ event: "error", data: { code, message } });
    return this;
  }

  /**
   * Drop the connection after `count` events. The turn itself still completes: MockTwigg writes
   * it all to history and the run record, so the SDK's recovery can be exercised end to end.
   */
  disconnectAfter(count: number): this {
    this.dropAfter = count;
    return this;
  }

  toEvents(): ResponseEvent[] {
    return [...this.events];
  }

  toString(): string {
    return this.events.map((e) => formatSse(e.event, e.data)).join("");
  }

  /** A 200 event-stream Response, dropping the connection if `disconnectAfter` was set. */
  toResponse(): Response {
    return sseResponse(this.events, this.dropAfter);
  }

  private block(kind: "text" | "reasoning" | "refusal", deltas: string[]): this {
    this.events.push({ event: "block_start", data: { kind } });
    for (const text of deltas) this.events.push({ event: "delta", data: { kind, text } });
    this.events.push({ event: "block_stop", data: {} });
    return this;
  }
}

export function streamBuilder(run?: RunInfo): StreamBuilder {
  return new StreamBuilder(run);
}

/** An event-stream Response for `events`, failing after `dropAfter` events when given. */
export function sseResponse(events: ResponseEvent[], dropAfter?: number): Response {
  const sent = dropAfter === undefined ? events : events.slice(0, dropAfter);
  const bytes = new TextEncoder().encode(sent.map((e) => formatSse(e.event, e.data)).join(""));
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!done) {
        done = true;
        controller.enqueue(bytes);
      } else if (dropAfter !== undefined) controller.error(new TypeError("terminated"));
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
