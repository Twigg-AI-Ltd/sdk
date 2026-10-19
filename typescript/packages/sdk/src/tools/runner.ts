// The tool loop: stream a turn, run the tools it asks for, submit their results, repeat until the
// model answers without asking for more.
import type { ChatRef } from "../resources/chats.js";
import type { ResponseRequest, Responses } from "../resources/responses.js";
import type { ResponseStream, StreamEvent, StreamOptions } from "../streaming/response-stream.js";
import type { ResponseResult, ToolCall } from "../streaming/result.js";
import type { OpenChatRequest, SubmittedPart } from "../types.js";
import { type AnyTool, type ToolContext, type ToolOutput, ToolResult } from "./tool.js";

type ToolResultPart = Extract<SubmittedPart, { type: "tool_result" }>;

/** A handler for a tool already published to the namespace, matched by name. */
export type ToolHandler = (
  input: unknown,
  context: ToolContext,
) => ToolOutput | Promise<ToolOutput>;

export interface RunToolsRequest extends Omit<ResponseRequest, "tools" | "idempotency_key"> {
  /** Tools sent with every turn and run locally. */
  tools?: AnyTool[];
  /** Handlers for tools published to the namespace, by name. Not sent with the request. */
  handlers?: Record<string, ToolHandler>;
  /** Model turns before stopping. Default 20. */
  maxIterations?: number;
  /** Tool calls run at once within a turn. Default 8. */
  toolConcurrency?: number;
  /**
   * What a tool that throws does. `send` (default) returns the error to the model as an
   * `is_error` result so it can correct itself; `throw` stops the loop and rethrows.
   */
  onToolError?: "send" | "throw";
  /**
   * Turn `n` is submitted with `${idempotencyKey}-${n}`, so a loop restarted with the same key
   * recovers turns that already ran instead of repeating them. Generated per turn when absent.
   */
  idempotencyKey?: string;
}

export type ToolRunEvent =
  | { type: "turn"; iteration: number; stream: ResponseStream }
  | { type: "event"; iteration: number; event: StreamEvent }
  | { type: "tool_result"; iteration: number; call: ToolCall; result: ToolResultPart };

export interface ToolRunResult {
  /** The last turn's result. */
  result: ResponseResult;
  /** Every turn, in order. */
  turns: ResponseResult[];
  /**
   * `end_turn` and friends when the model stopped; `max_iterations` when the loop hit its limit;
   * `unhandled_tool_calls` when the model called a tool with no local tool or handler. The
   * pending calls are then on `result.pendingToolCalls` for the caller to answer.
   */
  stopReason: ResponseResult["stopReason"] | "max_iterations" | "unhandled_tool_calls";
}

export class ToolRunner implements AsyncIterable<ToolRunEvent> {
  private readonly events: ToolRunEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: unknown;
  private started: Promise<ToolRunResult> | undefined;

  constructor(
    private readonly responses: Responses,
    private readonly chat: ChatRef,
    private readonly request: RunToolsRequest & { chat?: OpenChatRequest | null },
    private readonly options: StreamOptions = {},
  ) {}

  /** Run the loop to the end. */
  final(): Promise<ToolRunResult> {
    this.started ??= this.loop().then(
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

  async *[Symbol.asyncIterator](): AsyncGenerator<ToolRunEvent> {
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

  private async loop(): Promise<ToolRunResult> {
    const {
      tools = [],
      handlers = {},
      maxIterations = 20,
      toolConcurrency = 8,
      onToolError = "send",
      idempotencyKey,
      ...request
    } = this.request;
    const local = new Map<string, AnyTool>(tools.map((t) => [t.name, t]));
    // A Map, so a model-chosen name like "constructor" cannot reach Object.prototype.
    const handled = new Map<string, ToolHandler>(Object.entries(handlers));
    const definitions = tools.map((t) => t.definition);
    const turns: ResponseResult[] = [];
    let input = request.input;

    for (let iteration = 0; ; iteration++) {
      const stream = this.responses.createAt(
        this.chat,
        {
          ...request,
          input,
          ...(definitions.length > 0 ? { tools: definitions } : {}),
          ...(idempotencyKey ? { idempotency_key: `${idempotencyKey}-${iteration}` } : {}),
        },
        this.options,
      );
      this.publish({ type: "turn", iteration, stream });
      stream.on("event", (event) => this.publish({ type: "event", iteration, event }));
      const result = await stream.final();
      turns.push(result);

      const pending = result.pendingToolCalls;
      // A restarted loop recovered a turn whose calls a later submission already answered.
      // Resubmitting those same results under the next key reaches the turn that followed
      // (the key is used, so the API answers 409 naming it) without running any tool again.
      if (result.answeredToolResults && pending.length === 0 && iteration + 1 < maxIterations) {
        input = result.answeredToolResults;
        continue;
      }
      if (result.stopReason !== "tool_use" || pending.length === 0)
        return { result, turns, stopReason: result.stopReason };
      if (pending.some((call) => !local.has(call.name) && !handled.has(call.name)))
        return { result, turns, stopReason: "unhandled_tool_calls" };
      if (iteration + 1 >= maxIterations) return { result, turns, stopReason: "max_iterations" };

      input = await pool(pending, toolConcurrency, async (call) => {
        const part = await this.execute(
          call,
          result,
          local.get(call.name),
          handled.get(call.name),
          onToolError,
        );
        this.publish({ type: "tool_result", iteration, call, result: part });
        return part;
      });
    }
  }

  private async execute(
    call: ToolCall,
    turn: ResponseResult,
    local: AnyTool | undefined,
    handler: ToolHandler | undefined,
    onToolError: "send" | "throw",
  ): Promise<ToolResultPart> {
    const base = { type: "tool_result" as const, tool_use_id: call.id, tool_name: call.name };
    if (call.inputError)
      return {
        ...base,
        text: `The arguments were not valid JSON: ${call.inputError}`,
        is_error: true,
      };
    const context: ToolContext = {
      call,
      chatId: turn.chatId,
      runId: turn.runId,
      signal: this.options.signal,
    };
    try {
      let output: ToolOutput;
      if (local) {
        const parsed = await local.parse(call.input);
        if (!parsed.ok)
          return {
            ...base,
            text: `Invalid arguments for ${call.name}: ${parsed.message}`,
            is_error: true,
          };
        output = await local.run(parsed.value, context);
      } else {
        // biome-ignore lint/style/noNonNullAssertion: the loop only executes handled calls.
        output = await handler!(call.input, context);
      }
      return { ...base, ...toResultFields(output) };
    } catch (error) {
      if (onToolError === "throw") throw error;
      return {
        ...base,
        text: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        is_error: true,
      };
    }
  }

  private publish(event: ToolRunEvent): void {
    this.events.push(event);
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
}

function toResultFields(
  output: ToolOutput,
): Omit<ToolResultPart, "type" | "tool_use_id" | "tool_name"> {
  if (output instanceof ToolResult)
    return {
      text: output.text,
      is_error: output.isError,
      ...(output.media.length > 0 ? { media: output.media } : {}),
      ...(output.trust ? { trust: output.trust } : {}),
    };
  if (typeof output === "string") return { text: output, is_error: false };
  if (output === undefined || output === null) return { text: "", is_error: false };
  return { text: JSON.stringify(output), is_error: false };
}

/** Map with at most `limit` calls in flight, keeping input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next++;
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds.
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
