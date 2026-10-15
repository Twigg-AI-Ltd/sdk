import type { ResponseResult } from "../src/index.js";

/** Map a result into the language-neutral shape in fixtures/README.md. */
export function toConformance(result: ResponseResult) {
  return {
    run_id: result.runId,
    chat_id: result.chatId,
    text: result.text,
    reasoning: result.reasoning,
    refusal: result.refusal,
    blocks: result.blocks.map((block) =>
      block.type === "tool_call"
        ? {
            type: "tool_call",
            id: block.call.id,
            name: block.call.name,
            input: block.call.input ?? null,
            raw_input: block.call.rawInput,
            ...(block.call.inputError ? { input_error: block.call.inputError } : {}),
          }
        : block,
    ),
    pending_tool_call_ids: result.pendingToolCalls.map((call) => call.id),
    closed_tool_call_ids: result.closedToolCalls,
    stop_reason: result.stopReason,
    usage: result.usage,
    cost: result.cost,
    cost_currency: result.costCurrency,
    model_served: result.modelServed,
    warnings: result.warnings,
  };
}
