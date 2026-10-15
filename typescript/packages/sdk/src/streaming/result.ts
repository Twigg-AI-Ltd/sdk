import type {
  ChatId,
  ConfigWarning,
  ErrorBody,
  Money,
  ResponseEvent,
  RunId,
  StopReason,
  SubmittedPart,
  ToolUseId,
  TranslationWarning,
  Usage,
} from "../types.js";

type EventData<E extends ResponseEvent["event"]> = Extract<ResponseEvent, { event: E }>["data"];
export type DoneData = EventData<"done">;

/** A tool call the model made, with its arguments parsed. */
export interface ToolCall {
  id: ToolUseId;
  name: string;
  /** The parsed arguments; `undefined` when `rawInput` was not valid JSON. */
  input: unknown;
  /** The argument text exactly as the model produced it. */
  rawInput: string;
  /** Why `rawInput` did not parse, when it did not. */
  inputError?: string;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "refusal"; text: string }
  | { type: "tool_call"; call: ToolCall };

export type TwiggWarning =
  | ({ source: "config" } & ConfigWarning)
  | ({ source: "translation" } & TranslationWarning);

/** Everything one turn produced. */
export interface ResponseResult {
  runId: RunId;
  chatId: ChatId;
  /** All text blocks joined, in order. */
  text: string;
  /** All reasoning blocks joined, in order. Empty when the model exposed none. */
  reasoning: string;
  /** The model's refusal, when it refused. */
  refusal: string | null;
  /** Every block in the order the model produced it. */
  blocks: Block[];
  toolCalls: ToolCall[];
  /** Tool calls waiting for a `tool_result`: answer these in the next submission. */
  pendingToolCalls: ToolCall[];
  /** Pending calls from earlier turns that this submission closed. */
  closedToolCalls: ToolUseId[];
  stopReason: StopReason;
  usage: Usage;
  /** What the turn cost as a decimal string; `null` while settlement is pending. */
  cost: Money | null;
  costCurrency: string;
  /** The provider's own model identifier. Not a catalogue name. */
  modelServed: string | null;
  providerResponseId: string | null;
  compaction: DoneData["compaction"];
  serverTools: DoneData["server_tools"];
  warnings: TwiggWarning[];
  /**
   * On a recovered result only: tool results a later submission already sent for this turn's
   * calls. Those calls are then not pending. A restarted tool loop resubmits these under its next
   * idempotency key to reach the turn that followed, instead of running the tools again.
   */
  answeredToolResults?: SubmittedPart[];
  /**
   * True when the connection dropped and this result was rebuilt from the run and chat history.
   * `stopReason` is then inferred, and `providerResponseId`, `compaction` and `serverTools` are
   * not available.
   */
  recovered: boolean;
}

/** Folds stream events into a ResponseResult. Feed events in order. */
export class ResponseAccumulator {
  runId: RunId | undefined;
  chatId: ChatId | undefined;
  closedToolCalls: ToolUseId[] = [];
  readonly blocks: Block[] = [];
  readonly warnings: TwiggWarning[] = [];
  done: DoneData | undefined;
  error: ErrorBody | undefined;
  private open: Block | undefined;

  get finished(): boolean {
    return this.done !== undefined || this.error !== undefined;
  }

  get toolCalls(): ToolCall[] {
    return this.blocks.flatMap((b) => (b.type === "tool_call" ? [b.call] : []));
  }

  /** Apply one event; returns the tool call it completed, if any. */
  push(event: ResponseEvent): ToolCall | undefined {
    switch (event.event) {
      case "run":
        this.runId = event.data.run_id;
        this.chatId = event.data.chat_id;
        this.closedToolCalls = event.data.closed_tool_calls;
        return undefined;
      case "config_warnings":
        for (const w of event.data.warnings) this.warn({ source: "config", ...w });
        return undefined;
      case "translation_warnings":
        for (const w of event.data.warnings) this.warn({ source: "translation", ...w });
        return undefined;
      case "compacting":
        return undefined;
      case "block_start": {
        const completed = this.close();
        const start = event.data;
        this.open =
          start.kind === "tool_call"
            ? {
                type: "tool_call",
                call: {
                  id: start.tool_use_id,
                  name: start.tool_name,
                  input: undefined,
                  rawInput: "",
                },
              }
            : emptyBlock(start.kind);
        return completed;
      }
      case "delta": {
        const delta = event.data;
        // A delta outside a block of its kind still counts, so no text is ever lost.
        let completed: ToolCall | undefined;
        let block: Block | undefined = this.open;
        if (!block || !matches(block, delta.kind)) {
          completed = this.close();
          block = emptyBlock(delta.kind === "tool_input" ? "tool_call" : delta.kind);
          this.open = block;
        }
        if (block.type === "tool_call") block.call.rawInput += delta.text;
        else block.text += delta.text;
        return completed;
      }
      case "block_stop":
        return this.close();
      case "done":
        this.done = event.data;
        return this.close();
      case "error":
        this.error = event.data;
        return this.close();
    }
  }

  private readonly seen = new Set<string>();

  /** Keep a warning once: they may repeat after compaction. */
  private warn(warning: TwiggWarning): void {
    const key = JSON.stringify(warning);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.warnings.push(warning);
  }

  /** Close the open block, keeping it unless it is an empty text-like block. */
  private close(): ToolCall | undefined {
    const block = this.open;
    this.open = undefined;
    if (!block) return undefined;
    if (block.type !== "tool_call") {
      if (block.text !== "") this.blocks.push(block);
      return undefined;
    }
    parseInput(block.call);
    this.blocks.push(block);
    return block.call;
  }

  /** The finished result. Throws if the stream has not delivered `done`. */
  result(): ResponseResult {
    if (!this.done || !this.runId || !this.chatId)
      throw new Error("The stream has not finished successfully");
    const done = this.done;
    const calls = this.toolCalls;
    return {
      runId: this.runId,
      chatId: this.chatId,
      ...texts(this.blocks),
      blocks: this.blocks,
      toolCalls: calls,
      pendingToolCalls: done.pending_tool_calls.map(
        (p) =>
          calls.find((c) => c.id === p.tool_use_id) ?? {
            id: p.tool_use_id,
            name: p.tool_name,
            input: undefined,
            rawInput: "",
            inputError: "The stream carried no arguments for this call",
          },
      ),
      closedToolCalls: this.closedToolCalls,
      stopReason: done.stop_reason,
      usage: done.usage,
      cost: done.cost ?? null,
      costCurrency: done.cost_currency,
      modelServed: done.model_served ?? null,
      providerResponseId: done.provider_response_id ?? null,
      compaction: done.compaction ?? null,
      serverTools: done.server_tools ?? null,
      warnings: this.warnings,
      recovered: false,
    };
  }
}

function emptyBlock(type: Block["type"]): Block {
  // A tool call without a block_start has no id or name; its arguments are still kept.
  return type === "tool_call"
    ? { type, call: { id: "", name: "", input: undefined, rawInput: "" } }
    : { type, text: "" };
}

function matches(block: Block, kind: "text" | "reasoning" | "refusal" | "tool_input"): boolean {
  return kind === "tool_input" ? block.type === "tool_call" : block.type === kind;
}

/** Parse a call's raw argument text. Some providers send nothing for a no-argument call. */
export function parseInput(call: ToolCall): void {
  try {
    call.input = JSON.parse(call.rawInput === "" ? "{}" : call.rawInput);
    delete call.inputError;
  } catch (error) {
    call.input = undefined;
    call.inputError = error instanceof Error ? error.message : String(error);
  }
}

/** Join text, reasoning and refusal blocks. */
export function texts(blocks: Block[]): Pick<ResponseResult, "text" | "reasoning" | "refusal"> {
  let text = "";
  let reasoning = "";
  let refusal: string | null = null;
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    else if (block.type === "reasoning") reasoning += block.text;
    else if (block.type === "refusal") refusal = (refusal ?? "") + block.text;
  }
  return { text, reasoning, refusal };
}
