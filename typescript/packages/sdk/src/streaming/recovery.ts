// Rebuilding a turn's result after its stream dropped. Dropping the connection never cancels a
// turn, so the run finishes server-side; this waits for it, then reads what it wrote to history.

import type { RequestOptions } from "../core/transport.js";
import { StreamError } from "../errors.js";
import { toSubmittable } from "../media.js";
import type { ChatRef, Chats } from "../resources/chats.js";
import type { Runs } from "../resources/runs.js";
import type { HistoryPart, RunId, RunInspection, StopReason } from "../types.js";
import {
  type Block,
  parseInput,
  type ResponseAccumulator,
  type ResponseResult,
  texts,
} from "./result.js";

export interface RecoveryDeps {
  runs: Runs;
  chats: Chats;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const FIRST_POLL_MS = 500;
const MAX_POLL_MS = 5_000;

/** Wait until the run is no longer running, polling with backoff. */
export async function waitForRun(
  deps: RecoveryDeps,
  runId: RunId,
  timeout: number,
  options: RequestOptions,
): Promise<RunInspection> {
  const deadline = Date.now() + timeout;
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    const run = await deps.runs.get(runId, options);
    if (run.status !== "running") return run;
    if (Date.now() + wait > deadline)
      throw new StreamError(`Run ${runId} was still running after ${timeout}ms`, {
        code: "recovery_timeout",
        runId,
      });
    await deps.sleep(wait, options.signal);
  }
}

/**
 * The finished run's result, rebuilt from history. The turn's output is the run of assistant
 * parts at the end of the chat written since the run started; reading stops at the first user
 * part, which is the input this turn answered.
 */
export async function recoverResult(
  deps: RecoveryDeps,
  chat: ChatRef,
  runId: RunId,
  accumulator: ResponseAccumulator,
  timeout: number,
  options: RequestOptions,
): Promise<ResponseResult> {
  const run = await waitForRun(deps, runId, timeout, options);
  if (run.status === "failed")
    throw new StreamError(run.error ?? `Run ${runId} failed`, { code: "run_failed", runId });

  // The turn's output is the assistant parts written between the run's start and finish.
  // Parts after it belong to later turns: skip them, but note the tool results they sent,
  // because those already answered this turn's calls.
  const started = Date.parse(run.created_at);
  const finished = run.completed_at ? Date.parse(run.completed_at) : Number.POSITIVE_INFINITY;
  const parts: HistoryPart[] = [];
  const later = new Map<string, HistoryPart>();
  for await (const part of deps.chats.historyAt(chat, {}, options)) {
    const at = Date.parse(part.created_at);
    if (at > finished) {
      if (part.part.type === "tool_result") later.set(part.part.tool_use_id, part);
      continue;
    }
    if (part.role !== "assistant" || at < started) break;
    parts.unshift(part);
  }
  const blocks = parts.flatMap(toBlock);
  const toolCalls = blocks.flatMap((b) => (b.type === "tool_call" ? [b.call] : []));
  const answered = toolCalls.flatMap((call) => {
    const part = later.get(call.id);
    return part ? [toSubmittable(part)] : [];
  });
  const stopReason: StopReason =
    run.status === "cancelled" ? "aborted" : toolCalls.length > 0 ? "tool_use" : "end_turn";
  return {
    runId,
    chatId: run.chat_id,
    ...texts(blocks),
    blocks,
    toolCalls,
    // A turn that called tools ends there; the results arrive with the next submission,
    // unless a later submission already sent them.
    pendingToolCalls:
      stopReason === "tool_use" ? toolCalls.filter((call) => !later.has(call.id)) : [],
    ...(answered.length > 0 ? { answeredToolResults: answered } : {}),
    closedToolCalls: accumulator.closedToolCalls,
    stopReason,
    usage: run.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
    cost: run.cost ?? null,
    // The run record has no currency; Twigg bills in US dollars.
    costCurrency: "USD",
    modelServed: null,
    providerResponseId: null,
    compaction: null,
    serverTools: null,
    warnings: accumulator.warnings,
    recovered: true,
  };
}

function toBlock(part: HistoryPart): Block[] {
  const body = part.part;
  switch (body.type) {
    case "message": {
      const blocks: Block[] = [];
      if (body.text) blocks.push({ type: "text", text: body.text });
      if (body.refusal) blocks.push({ type: "refusal", text: body.refusal });
      return blocks;
    }
    case "reasoning":
      return body.text ? [{ type: "reasoning", text: body.text }] : [];
    case "tool_call": {
      const call = {
        id: body.tool_use_id,
        name: body.tool_name,
        input: undefined,
        rawInput: body.arguments,
      };
      parseInput(call);
      return [{ type: "tool_call", call }];
    }
    default:
      return [];
  }
}
