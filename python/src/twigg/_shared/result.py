"""Folding stream events into a result, and the typed events a stream yields."""

from __future__ import annotations

import json
import typing
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

from pydantic import ValidationError

from .._generated.models import Usage
from ..errors import invalid_response

StopReason = Literal["end_turn", "max_tokens", "tool_use", "stop_sequence", "refusal", "aborted"]


@dataclass
class ToolCall:
    """A tool call the model made, with its arguments parsed."""

    id: str
    name: str
    #: The parsed arguments; `None` when `raw_input` was not valid JSON.
    input: Any
    #: The argument text exactly as the model produced it.
    raw_input: str
    #: Why `raw_input` did not parse, when it did not.
    input_error: str | None = None


@dataclass
class TextBlock:
    text: str
    type: Literal["text"] = "text"


@dataclass
class ReasoningBlock:
    text: str
    type: Literal["reasoning"] = "reasoning"


@dataclass
class RefusalBlock:
    text: str
    type: Literal["refusal"] = "refusal"


@dataclass
class ToolCallBlock:
    call: ToolCall
    type: Literal["tool_call"] = "tool_call"


@dataclass
class UnknownBlock:
    """A block of a kind this SDK version does not know. Its text is kept here and left out of
    `text`, `reasoning` and `refusal`."""

    kind: str
    text: str
    type: Literal["unknown"] = "unknown"


Block = TextBlock | ReasoningBlock | RefusalBlock | ToolCallBlock | UnknownBlock


@dataclass(frozen=True)
class TwiggWarning:
    """A configuration or translation warning. `data` holds the warning's own fields."""

    source: Literal["config", "translation"]
    code: str
    data: dict[str, Any]


@dataclass
class ResponseResult:
    """Everything one turn produced."""

    run_id: str
    chat_id: str
    #: All text blocks joined, in order.
    text: str
    #: All reasoning blocks joined, in order. Empty when the model exposed none.
    reasoning: str
    #: The model's refusal, when it refused.
    refusal: str | None
    #: Every block in the order the model produced it.
    blocks: list[Block]
    tool_calls: list[ToolCall]
    #: Tool calls waiting for a `tool_result`: answer these in the next submission.
    pending_tool_calls: list[ToolCall]
    #: Pending calls from earlier turns that this submission closed.
    closed_tool_calls: list[str]
    stop_reason: StopReason
    usage: Usage
    #: What the turn cost; `None` while settlement is pending.
    cost: Decimal | None
    cost_currency: str
    #: The provider's own model identifier. Not a catalogue name.
    model_served: str | None
    provider_response_id: str | None
    compaction: dict[str, Any] | None
    server_tools: dict[str, Any] | None
    warnings: list[TwiggWarning]
    #: True when the connection dropped and this result was rebuilt from the run and chat
    #: history. `stop_reason` is then inferred, and `provider_response_id`, `compaction` and
    #: `server_tools` are not available.
    recovered: bool = False
    #: On a recovered result only: tool results a later submission already sent for this
    #: turn's calls, as parts ready to submit. A restarted tool loop resubmits these instead of
    #: running the tools again.
    answered_tool_results: list[dict[str, Any]] | None = None


# Typed events. Each keeps the raw payload on `data`; match on the class or on `event`.


@dataclass(frozen=True)
class RunEvent:
    run_id: str
    chat_id: str
    closed_tool_calls: list[str]
    data: dict[str, Any] = field(repr=False)
    event: Literal["run"] = "run"


@dataclass(frozen=True)
class WarningsEvent:
    """`config_warnings` or `translation_warnings`."""

    event: Literal["config_warnings", "translation_warnings"]
    warnings: list[TwiggWarning]
    data: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class CompactingEvent:
    """The turn is waiting for history to be compacted."""

    blocks: int
    in_progress_elsewhere: int
    data: dict[str, Any] = field(repr=False)
    event: Literal["compacting"] = "compacting"


@dataclass(frozen=True)
class BlockStartEvent:
    #: One of `text`, `reasoning`, `refusal` or `tool_call`, or a kind added since.
    kind: str
    tool_use_id: str | None
    tool_name: str | None
    data: dict[str, Any] = field(repr=False)
    event: Literal["block_start"] = "block_start"


@dataclass(frozen=True)
class DeltaEvent:
    #: One of `text`, `reasoning`, `refusal` or `tool_input`, or a kind added since.
    kind: str
    text: str
    data: dict[str, Any] = field(repr=False)
    event: Literal["delta"] = "delta"


@dataclass(frozen=True)
class BlockStopEvent:
    #: The tool call this block completed, if it was one.
    tool_call: ToolCall | None
    data: dict[str, Any] = field(repr=False)
    event: Literal["block_stop"] = "block_stop"


@dataclass(frozen=True)
class DoneEvent:
    stop_reason: StopReason
    data: dict[str, Any] = field(repr=False)
    event: Literal["done"] = "done"


@dataclass(frozen=True)
class ErrorEvent:
    code: str
    message: str
    hint: str | None
    details: Any
    data: dict[str, Any] = field(repr=False)
    event: Literal["error"] = "error"


@dataclass(frozen=True)
class RecoveredEvent:
    """The connection dropped and the result was rebuilt from the run and history."""

    result: ResponseResult
    event: Literal["recovered"] = "recovered"


@dataclass(frozen=True)
class UnknownEvent:
    """An event this SDK version does not know, passed through for forward compatibility."""

    event: str
    data: Any


StreamEvent = (
    RunEvent
    | WarningsEvent
    | CompactingEvent
    | BlockStartEvent
    | DeltaEvent
    | BlockStopEvent
    | DoneEvent
    | ErrorEvent
    | RecoveredEvent
    | UnknownEvent
)


class ResponseAccumulator:
    """Folds raw stream events into a ResponseResult. Feed events in order."""

    def __init__(self) -> None:
        self.run_id: str | None = None
        self.chat_id: str | None = None
        self.closed_tool_calls: list[str] = []
        self.blocks: list[Block] = []
        self.warnings: list[TwiggWarning] = []
        self.done: dict[str, Any] | None = None
        self.error: dict[str, Any] | None = None
        self._open: Block | None = None
        #: The tool call the last pushed event completed, if any.
        self.last_completed: ToolCall | None = None
        #: Warnings the last pushed event added that had not been seen before.
        self.last_new_warnings: list[TwiggWarning] = []
        self._seen_warnings: set[str] = set()

    @property
    def finished(self) -> bool:
        return self.done is not None or self.error is not None

    @property
    def tool_calls(self) -> list[ToolCall]:
        return [b.call for b in self.blocks if isinstance(b, ToolCallBlock)]

    def push(self, name: str, data: Any) -> StreamEvent:
        """Apply one raw event and return it typed."""
        self.last_completed = None
        self.last_new_warnings = []
        payload = typing.cast("dict[str, Any]", data if isinstance(data, dict) else {})
        if name == "run":
            if "run_id" not in payload or "chat_id" not in payload:
                raise invalid_response("run event", ValueError("run_id or chat_id missing"))
            self.run_id = str(payload["run_id"])
            self.chat_id = str(payload["chat_id"])
            self.closed_tool_calls = [str(c) for c in payload.get("closed_tool_calls", [])]
            return RunEvent(self.run_id, self.chat_id, self.closed_tool_calls, payload)
        if name in ("config_warnings", "translation_warnings"):
            source: Literal["config", "translation"] = (
                "config" if name == "config_warnings" else "translation"
            )
            warnings = [
                TwiggWarning(source, str(w.get("code", "")), dict(w))
                for w in payload.get("warnings", [])
            ]
            for warning in warnings:
                # Warnings repeat after compaction; keep each once.
                key = json.dumps([warning.source, warning.data], sort_keys=True, default=str)
                if key not in self._seen_warnings:
                    self._seen_warnings.add(key)
                    self.warnings.append(warning)
                    self.last_new_warnings.append(warning)
            return WarningsEvent(name, warnings, payload)  # pyright: ignore[reportArgumentType]
        if name == "compacting":
            return CompactingEvent(
                int(payload.get("blocks", 0)), int(payload.get("in_progress_elsewhere", 0)), payload
            )
        if name == "block_start":
            self._close()
            kind = payload.get("kind", "text")
            if kind == "tool_call":
                tool_use_id, tool_name = payload.get("tool_use_id"), payload.get("tool_name")
                call = ToolCall(str(tool_use_id or ""), str(tool_name or ""), None, "")
                self._open = ToolCallBlock(call)
            else:
                self._open = _empty_block(kind)
            return BlockStartEvent(
                kind, payload.get("tool_use_id"), payload.get("tool_name"), payload
            )
        if name == "delta":
            kind = payload.get("kind", "text")
            text = str(payload.get("text", ""))
            block = self._open
            # A delta outside a block of its kind still counts, so no text is ever lost.
            if block is None or not _matches(block, kind):
                self._close()
                block = _empty_block("tool_call" if kind == "tool_input" else kind)
                self._open = block
            if isinstance(block, ToolCallBlock):
                block.call.raw_input += text
            else:
                block.text += text
            return DeltaEvent(kind, text, payload)
        if name == "block_stop":
            return BlockStopEvent(self._close(), payload)
        if name == "done":
            self.done = payload
            self._close()
            return DoneEvent(payload.get("stop_reason", "end_turn"), payload)
        if name == "error":
            self.error = payload
            self._close()
            return ErrorEvent(
                str(payload.get("code", "stream_error")),
                str(payload.get("message", "")),
                payload.get("hint"),
                payload.get("details"),
                payload,
            )
        return UnknownEvent(name, data)

    def result(self) -> ResponseResult:
        """The finished result. Raises if the stream has not delivered `done`."""
        if self.done is None or self.run_id is None or self.chat_id is None:
            raise RuntimeError("The stream has not finished successfully")
        done = self.done
        calls = self.tool_calls
        by_id = {c.id: c for c in calls}
        pending = [
            by_id.get(str(p["tool_use_id"]))
            or ToolCall(
                str(p["tool_use_id"]),
                str(p["tool_name"]),
                None,
                "",
                "The stream carried no arguments for this call",
            )
            for p in done.get("pending_tool_calls", [])
        ]
        text, reasoning, refusal = join_texts(self.blocks)
        cost = done.get("cost")
        try:
            usage = Usage.model_validate(done.get("usage") or EMPTY_USAGE)
        except ValidationError as error:
            raise invalid_response("done event usage", error) from error
        return ResponseResult(
            run_id=self.run_id,
            chat_id=self.chat_id,
            text=text,
            reasoning=reasoning,
            refusal=refusal,
            blocks=self.blocks,
            tool_calls=calls,
            pending_tool_calls=pending,
            closed_tool_calls=self.closed_tool_calls,
            stop_reason=done.get("stop_reason", "end_turn"),
            usage=usage,
            cost=None if cost is None else Decimal(str(cost)),
            cost_currency=str(done.get("cost_currency", "USD")),
            model_served=done.get("model_served"),
            provider_response_id=done.get("provider_response_id"),
            compaction=done.get("compaction"),
            server_tools=done.get("server_tools"),
            warnings=self.warnings,
        )

    def _close(self) -> ToolCall | None:
        """Close the open block, keeping it unless it is an empty text-like block."""
        block = self._open
        self._open = None
        if block is None:
            return None
        if not isinstance(block, ToolCallBlock):
            if block.text:
                self.blocks.append(block)
            return None
        parse_input(block.call)
        self.blocks.append(block)
        self.last_completed = block.call
        return block.call


EMPTY_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0,
}


def parse_input(call: ToolCall) -> None:
    """Parse a call's raw argument text. Some providers send nothing for a no-argument call."""
    try:
        call.input = json.loads(call.raw_input or "{}")
        call.input_error = None
    except ValueError as error:
        call.input = None
        call.input_error = str(error)


def join_texts(blocks: list[Block]) -> tuple[str, str, str | None]:
    """Text, reasoning and refusal, each joined across blocks."""
    text = "".join(b.text for b in blocks if isinstance(b, TextBlock))
    reasoning = "".join(b.text for b in blocks if isinstance(b, ReasoningBlock))
    refusals = [b.text for b in blocks if isinstance(b, RefusalBlock)]
    return text, reasoning, "".join(refusals) if refusals else None


def _empty_block(kind: str) -> Block:
    if kind == "tool_call":
        # A tool call without a block_start has no id or name; its arguments are still kept.
        return ToolCallBlock(ToolCall("", "", None, ""))
    if kind == "reasoning":
        return ReasoningBlock("")
    if kind == "refusal":
        return RefusalBlock("")
    if kind == "text":
        return TextBlock("")
    return UnknownBlock(kind, "")


def _matches(block: Block, kind: str) -> bool:
    if kind == "tool_input":
        return isinstance(block, ToolCallBlock)
    if isinstance(block, UnknownBlock):
        return block.kind == kind
    return block.type == kind
