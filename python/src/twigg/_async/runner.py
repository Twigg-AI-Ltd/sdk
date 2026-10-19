"""The tool loop: stream a turn, run the tools it asks for, submit their results, repeat until
the model answers without asking for more."""

from __future__ import annotations

import inspect
from collections.abc import AsyncGenerator, AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any, Literal

from .._shared.result import ResponseResult, StreamEvent, ToolCall
from .._shared.tools import (
    Tool,
    ToolContext,
    ToolHandler,
    ToolRunResult,
    error_text,
    result_fields,
)
from ..errors import StreamError
from ._support import Lock, call_tool, gather_limited, try_acquire

if TYPE_CHECKING:
    from .resources import ChatRef
    from .responses import AsyncResponses
    from .stream import AsyncResponseStream


@dataclass(frozen=True)
class TurnStarted:
    iteration: int
    stream: AsyncResponseStream
    type: Literal["turn"] = "turn"


@dataclass(frozen=True)
class TurnEvent:
    iteration: int
    event: StreamEvent
    type: Literal["event"] = "event"


@dataclass(frozen=True)
class ToolResultSubmitted:
    iteration: int
    call: ToolCall
    result: dict[str, Any]
    type: Literal["tool_result"] = "tool_result"


ToolRunEvent = TurnStarted | TurnEvent | ToolResultSubmitted


class AsyncToolRunner:
    """Call `final()` for the outcome, or iterate for every turn's events and every tool result
    submitted."""

    def __init__(
        self,
        responses: AsyncResponses,
        chat: ChatRef,
        request: dict[str, Any],
        *,
        tools: Sequence[Tool],
        handlers: Mapping[str, ToolHandler],
        max_iterations: int,
        tool_concurrency: int,
        on_tool_error: Literal["send", "throw"],
        idempotency_key: str | None,
        stream_options: dict[str, Any],
    ) -> None:
        self._responses = responses
        self._chat = chat
        self._request = request
        self._tools = {t.name: t for t in tools}
        self._handlers = dict(handlers)
        self._max_iterations = max_iterations
        self._tool_concurrency = _at_least_one(tool_concurrency)
        self._on_tool_error = on_tool_error
        self._idempotency_key = idempotency_key
        self._stream_options = stream_options
        self._events: list[ToolRunEvent] = []
        self._driver: AsyncGenerator[ToolRunEvent, None] | None = None
        self._lock = Lock()
        self._ended = False
        self._failure: BaseException | None = None
        self._outcome: ToolRunResult | None = None
        self._stream: AsyncResponseStream | None = None

    async def __aenter__(self) -> AsyncToolRunner:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Stop the loop and close the current turn's connection. A turn already submitted
        carries on server-side; `final()` then raises `StreamError` with `code="closed"`."""
        stream = self._stream
        if stream is not None:
            await stream.close()
        if self._ended:
            return
        async with try_acquire(self._lock) as acquired:
            # When the lock is busy a turn is being read; closing its stream above ends it.
            if acquired and not self._ended:
                self._ended = True
                self._failure = StreamError("The tool loop was closed", code="closed")
                if self._driver is not None:
                    await self._driver.aclose()

    async def __aiter__(self) -> AsyncIterator[ToolRunEvent]:
        index = 0
        while True:
            if index < len(self._events):
                yield self._events[index]
                index += 1
                continue
            if self._ended:
                if self._failure is not None:
                    raise self._failure
                return
            await self._advance()

    async def final(self) -> ToolRunResult:
        """Run the loop to the end."""
        while await self._advance():
            pass
        if self._failure is not None:
            raise self._failure
        assert self._outcome is not None
        return self._outcome

    async def _advance(self) -> bool:
        async with self._lock:
            if self._ended:
                return False
            if self._driver is None:
                self._driver = self._drive()
            try:
                event = await self._driver.__anext__()
            except StopAsyncIteration:
                self._ended = True
                return False
            except BaseException as error:
                self._ended = True
                self._failure = error
                raise
            self._events.append(event)
            return True

    async def _drive(self) -> AsyncGenerator[ToolRunEvent, None]:
        definitions = [t.definition for t in self._tools.values()]
        turns: list[ResponseResult] = []
        parts: list[Any] = list(self._request.pop("input"))
        iteration = 0
        while True:
            stream = self._responses._stream(
                self._chat,
                **self._request,
                input=parts,
                tools=definitions or None,
                idempotency_key=(
                    f"{self._idempotency_key}-{iteration}" if self._idempotency_key else None
                ),
                **self._stream_options,
            )
            self._stream = stream
            yield TurnStarted(iteration, stream)
            async for event in stream:
                yield TurnEvent(iteration, event)
            result = await stream.final()
            turns.append(result)

            pending = result.pending_tool_calls
            # A restarted loop recovered a turn whose calls a later submission already
            # answered. Resubmitting those same results under the next key reaches the turn
            # that followed (the key is used, so the API answers 409 naming it) without running
            # any tool again. Empty input would not do: the API validates input before the key.
            answered = result.answered_tool_results
            if answered and not pending and iteration + 1 < self._max_iterations:
                parts = list(answered)
                iteration += 1
                continue
            if result.stop_reason != "tool_use" or not pending:
                self._outcome = ToolRunResult(result, turns, result.stop_reason)
                return
            if any(c.name not in self._tools and c.name not in self._handlers for c in pending):
                self._outcome = ToolRunResult(result, turns, "unhandled_tool_calls")
                return
            if iteration + 1 >= self._max_iterations:
                self._outcome = ToolRunResult(result, turns, "max_iterations")
                return

            async def run(call: ToolCall, turn: ResponseResult = result) -> dict[str, Any]:
                return await self._execute(call, turn)

            parts = await gather_limited(pending, self._tool_concurrency, run)
            for call, part in zip(pending, parts, strict=True):
                yield ToolResultSubmitted(iteration, call, part)
            iteration += 1

    async def _execute(self, call: ToolCall, turn: ResponseResult) -> dict[str, Any]:
        base: dict[str, Any] = {
            "type": "tool_result",
            "tool_use_id": call.id,
            "tool_name": call.name,
        }
        if call.input_error is not None:
            text = f"The arguments were not valid JSON: {call.input_error}"
            return {**base, "text": text, "is_error": True}
        context = ToolContext(call, turn.chat_id, turn.run_id)
        try:
            local = self._tools.get(call.name)
            if local is not None:
                ok, value = local.parse(call.input)
                if not ok:
                    text = f"Invalid arguments for {call.name}: {value}"
                    return {**base, "text": text, "is_error": True}
                output = await call_tool(local.call, value, context, blocking=not local.is_async)
            else:
                handler = self._handlers[call.name]
                blocking = not inspect.iscoroutinefunction(handler)
                output = await call_tool(handler, call.input, context, blocking=blocking)
        except Exception as error:
            if self._on_tool_error == "throw":
                raise
            return {**base, "text": error_text(error), "is_error": True}
        return {**base, **result_fields(output)}


def _at_least_one(limit: object) -> int:
    """Concurrency as a whole number of at least one, whatever the caller passed."""
    try:
        return max(1, int(limit))  # pyright: ignore[reportArgumentType]
    except (TypeError, ValueError, OverflowError):
        return 1
