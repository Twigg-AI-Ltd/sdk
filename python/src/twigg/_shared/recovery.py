"""Rebuilding a turn's result after its stream dropped. Dropping the connection never cancels a
turn, so the run finishes server-side; the flavour-specific code waits for it and reads history,
and these pure helpers decide what belongs to the turn and build the result."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal

from .._generated.models import (
    HistoryMessage,
    HistoryPart,
    HistoryReasoning,
    HistoryToolCall,
    HistoryToolResult,
    RunInspection,
    Usage,
)
from ..media import to_submittable
from .result import (
    EMPTY_USAGE,
    Block,
    ReasoningBlock,
    RefusalBlock,
    ResponseAccumulator,
    ResponseResult,
    StopReason,
    TextBlock,
    ToolCall,
    ToolCallBlock,
    join_texts,
    parse_input,
)

FIRST_POLL = 0.5
MAX_POLL = 5.0
TERMINAL = frozenset({"succeeded", "failed", "cancelled"})


def is_finished(run: RunInspection) -> bool:
    """Whether a run is over. A status this SDK does not know counts as finished only once the
    run has a completion time, so a new in-progress state is waited out, not mistaken for an
    ending."""
    return run.status in TERMINAL or run.completed_at is not None


def classify(part: HistoryPart, run: RunInspection) -> Literal["later", "turn", "stop"]:
    """Where a part stands relative to the run, walking history newest first. The turn's
    output is the assistant parts written between the run's start and finish. Parts after it
    belong to later turns and are skipped, though their tool results are worth noting: they
    already answered this turn's calls. The first part before it ends the walk."""
    if run.completed_at is not None and part.created_at > run.completed_at:
        return "later"
    if part.role != "assistant" or part.created_at < run.created_at:
        return "stop"
    return "turn"


def later_tool_result(part: HistoryPart) -> str | None:
    """The call a later part answered, when it is a tool result."""
    body = part.part
    return body.tool_use_id if isinstance(body, HistoryToolResult) else None


def recovered_result(
    run: RunInspection,
    parts: list[HistoryPart],
    accumulator: ResponseAccumulator,
    later: dict[str, HistoryPart] | None = None,
) -> ResponseResult:
    """The result of a finished run from its parts, oldest first. `later` holds tool results
    later submissions sent, by the call they answered."""
    answers = later or {}
    blocks = [block for part in parts for block in _blocks(part)]
    calls = [b.call for b in blocks if isinstance(b, ToolCallBlock)]
    stop_reason: StopReason = (
        "aborted" if run.status == "cancelled" else "tool_use" if calls else "end_turn"
    )
    text, reasoning, refusal = join_texts(blocks)
    answered: list[dict[str, Any]] = [
        to_submittable(answers[call.id]) for call in calls if call.id in answers
    ]
    return ResponseResult(
        run_id=str(run.id),
        chat_id=str(run.chat_id),
        text=text,
        reasoning=reasoning,
        refusal=refusal,
        blocks=blocks,
        tool_calls=calls,
        # A turn that called tools ends there; the results arrive with the next submission,
        # unless a later submission already sent them.
        pending_tool_calls=(
            [c for c in calls if c.id not in answers] if stop_reason == "tool_use" else []
        ),
        answered_tool_results=answered or None,
        closed_tool_calls=accumulator.closed_tool_calls,
        stop_reason=stop_reason,
        usage=run.usage or Usage.model_validate(EMPTY_USAGE),
        cost=None if run.cost is None else Decimal(run.cost),
        # The run record has no currency; Twigg bills in US dollars.
        cost_currency="USD",
        model_served=None,
        provider_response_id=None,
        compaction=None,
        server_tools=None,
        warnings=accumulator.warnings,
        recovered=True,
    )


def _blocks(part: HistoryPart) -> list[Block]:
    body = part.part
    if isinstance(body, HistoryMessage):
        blocks: list[Block] = []
        if body.text:
            blocks.append(TextBlock(body.text))
        if body.refusal:
            blocks.append(RefusalBlock(body.refusal))
        return blocks
    if isinstance(body, HistoryReasoning):
        return [ReasoningBlock(body.text)] if body.text else []
    if isinstance(body, HistoryToolCall):
        call = ToolCall(body.tool_use_id, body.tool_name, None, body.arguments)
        parse_input(call)
        return [ToolCallBlock(call)]
    return []
