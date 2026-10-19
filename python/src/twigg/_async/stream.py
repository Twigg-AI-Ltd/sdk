"""One turn's stream. Starts on first use, buffers every event so any number of consumers see
the whole turn, and turns a dropped connection into a recovered result instead of an error."""

from __future__ import annotations

import contextlib
import json
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from types import TracebackType
from typing import Any

import httpx

from .._generated.models import AbortAccepted, HistoryPart, RunInspection
from .._shared.recovery import (
    FIRST_POLL,
    MAX_POLL,
    classify,
    is_finished,
    later_tool_result,
    recovered_result,
)
from .._shared.request import ApiRequest, RequestOptions, should_retry
from .._shared.result import (
    DeltaEvent,
    RecoveredEvent,
    ResponseAccumulator,
    ResponseResult,
    RunEvent,
    StreamEvent,
    ToolCall,
    TwiggWarning,
    WarningsEvent,
)
from .._shared.sse import SseFrame, SseParser
from ..errors import APIConnectionError, ConflictError, IdempotencyConflictError, StreamError
from ._support import Lock, try_acquire
from .pagination import AsyncPage
from .resources import ChatRef, chat_path
from .transport import AsyncTransport


@dataclass(frozen=True)
class AsyncStreamDeps:
    transport: AsyncTransport
    get_run: Callable[[str], Awaitable[RunInspection]]
    history: Callable[[ChatRef], Awaitable[AsyncPage[HistoryPart]]]
    abort_run: Callable[[ChatRef, str], Awaitable[AbortAccepted]]
    on_warning: Callable[[TwiggWarning], None] | None


class AsyncResponseStream:
    """Iterate it for typed events, or call `final()` for the result. Nothing is sent until
    one of those happens. Use it as a context manager to close the connection early."""

    def __init__(
        self,
        deps: AsyncStreamDeps,
        chat: ChatRef,
        body: dict[str, Any],
        *,
        recover: bool = True,
        idle_timeout: float = 300.0,
        recovery_timeout: float = 600.0,
        options: RequestOptions | None = None,
    ) -> None:
        self._deps = deps
        #: The chat, by id or by external id; submit, abort and recovery all address it so.
        self._chat = chat
        self._body = body
        self._recover = recover
        self._idle_timeout = idle_timeout
        self._recovery_timeout = recovery_timeout
        self._options = options
        self._accumulator = ResponseAccumulator()
        self._events: list[StreamEvent] = []
        # Tool calls by the id() of the event that completed them; events are kept, so ids hold.
        self._completed: dict[int, ToolCall] = {}
        self._driver: AsyncGenerator[StreamEvent, None] | None = None
        self._response: httpx.Response | None = None
        self._lock = Lock()
        self._abort_lock = Lock()
        self._ended = False
        self._failure: BaseException | None = None
        self._result: ResponseResult | None = None
        self._recovered_run: str | None = None
        self._abort_requested = False
        # Set by close(): the reader stops without treating the closed socket as a drop.
        self._closed = False
        # True while a reader is inside the driver, which close() must not finalise then.
        self._reading = False

    async def __aenter__(self) -> AsyncResponseStream:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the connection. The turn carries on server-side; its output lands in history.

        Safe to call from another task or thread while the stream is being read, as a cancel
        button would: the reader stops at once and `final()` raises `StreamError` with
        `code="closed"`. Iterating with `break` keeps the connection open, so `final()` still
        works; use the stream as a context manager to close it when the block ends."""
        self._closed = True
        response = self._response
        if response is not None:
            # A reader blocked on this response wakes with a transport error and stops.
            await response.aclose()
        if self._reading or self._driver is None or self._ended:
            return
        async with try_acquire(self._lock) as acquired:
            if acquired and not self._ended:
                self._ended = True
                await self._driver.aclose()

    async def __aiter__(self) -> AsyncIterator[StreamEvent]:
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

    async def final(self) -> ResponseResult:
        """The finished result. Consumes the stream if nothing else is."""
        while await self._advance():
            pass
        if self._failure is not None:
            raise self._failure
        if self._result is None:
            raise StreamError("The stream was closed before the turn finished", code="closed")
        return self._result

    get_final_response = final

    @property
    def run_id(self) -> Awaitable[str]:
        """The run's id, as soon as the stream names it. Starts the stream."""
        return self._run_id()

    async def abort(self) -> None:
        """Stop the turn on the server. The stream carries on and ends with
        `stop_reason="aborted"`, unless the turn finished first."""
        # One request however many times this is called; later callers wait for the first.
        async with self._abort_lock:
            if self._abort_requested:
                return
            self._abort_requested = True
            run_id = self._accumulator.run_id or self._recovered_run
            if run_id is None:
                # The driver sends the abort as soon as the run is named, by a run event or a
                # 409 for a replayed key.
                await self._run_id()
                return
            if not self._ended:
                await self._abort(run_id)

    @property
    def text_stream(self) -> AsyncIterator[str]:
        """Just the text deltas, in order."""
        return self._text_stream()

    @property
    def tool_calls(self) -> AsyncIterator[ToolCall]:
        """Each tool call as soon as its arguments have fully arrived."""
        return self._tool_calls()

    async def _text_stream(self) -> AsyncIterator[str]:
        async for event in self:
            if isinstance(event, DeltaEvent) and event.kind == "text":
                yield event.text

    async def _tool_calls(self) -> AsyncIterator[ToolCall]:
        async for event in self:
            call = self._completed.get(id(event))
            if call is not None:
                yield call

    async def _run_id(self) -> str:
        while self._accumulator.run_id is None and self._recovered_run is None:
            if not await self._advance():
                if self._failure is not None:
                    raise self._failure
                raise StreamError("The stream ended without naming its run", code="no_run")
        return self._accumulator.run_id or self._recovered_run or ""

    async def _advance(self) -> bool:
        """Pull one event into the buffer. False once the stream has ended."""
        async with self._lock:
            if self._ended:
                return False
            if self._driver is None:
                self._driver = self._drive()
            self._reading = True
            try:
                event = await self._driver.__anext__()
            except StopAsyncIteration:
                self._ended = True
                return False
            except BaseException as error:
                self._ended = True
                self._failure = error
                raise
            finally:
                self._reading = False
            self._events.append(event)
            return True

    async def _drive(self) -> AsyncGenerator[StreamEvent, None]:
        transport = self._deps.transport
        body = {
            **self._body,
            "idempotency_key": self._body.get("idempotency_key") or str(uuid.uuid4()),
        }
        request = ApiRequest(
            "POST",
            f"{chat_path(self._chat)}/responses",
            body=body,
            # Safe to repeat: the idempotency key turns a duplicate into a 409 naming the run.
            idempotent=True,
            accept="text/event-stream",
        )
        max_retries = transport.max_retries(self._options)
        accumulator = self._accumulator
        attempt = 0
        while not self._closed:
            outcome = await transport.open(request, self._options, self._idle_timeout)
            if isinstance(outcome, tuple):
                error, retry_after = outcome
                if isinstance(error, IdempotencyConflictError) and self._recover:
                    async for event in self._recover_run(error.original_run_id):
                        yield event
                    return
                if not should_retry(request, error, attempt, max_retries):
                    raise error
                await transport.delay(retry_after, attempt)
                attempt += 1
                continue

            if self._closed:
                await outcome.aclose()
                return
            self._response = outcome
            dropped = ""
            parser = SseParser()
            try:
                async for chunk in outcome.aiter_bytes():
                    for frame in parser.feed(chunk):
                        event = await self._emit(frame)
                        if event is not None:
                            yield event
                    if accumulator.finished:
                        break
                if not accumulator.finished:
                    for frame in parser.close():
                        event = await self._emit(frame)
                        if event is not None:
                            yield event
                    dropped = "the connection closed"
            except httpx.ReadTimeout:
                dropped = f"no data for {self._idle_timeout}s"
            except (httpx.TransportError, httpx.StreamError) as cause:
                if not self._closed and not isinstance(cause, httpx.TransportError):
                    raise
                dropped = str(cause) or type(cause).__name__
            finally:
                await outcome.aclose()
                self._response = None
            if self._closed and not accumulator.finished:
                return  # Closed by the caller: not a dropped connection, so no recovery.

            if accumulator.done is not None:
                self._result = accumulator.result()
                return
            if accumulator.error is not None:
                failure = accumulator.error
                raise StreamError(
                    str(failure.get("message", "")),
                    code=str(failure.get("code", "stream_error")),
                    hint=failure.get("hint"),
                    details=failure.get("details"),
                    run_id=accumulator.run_id,
                )
            run_id = accumulator.run_id
            if run_id is not None and self._recover:
                async for event in self._recover_run(run_id):
                    yield event
                return
            # Dropped before the run was named: it may or may not have started. Submitting again
            # with the same key either starts it or answers 409 with the run to recover.
            if run_id is None and attempt < max_retries:
                await transport.delay(None, attempt)
                attempt += 1
                continue
            raise APIConnectionError(
                f"The stream ended before the turn finished: {dropped}", code="stream_interrupted"
            )

    async def _emit(self, frame: SseFrame) -> StreamEvent | None:
        try:
            data = json.loads(frame.data)
        except ValueError:
            return None  # Not a Twigg event.
        event = self._accumulator.push(frame.event, data)
        completed = self._accumulator.last_completed
        if completed is not None:
            self._completed[id(event)] = completed
        if isinstance(event, RunEvent) and self._abort_requested:
            await self._abort(event.run_id)
        if isinstance(event, WarningsEvent) and self._deps.on_warning is not None:
            # An exception from the hook fails the stream with it; it is not a dropped
            # connection, so it is never caught by the read loop's transport handling.
            for warning in self._accumulator.last_new_warnings:
                self._deps.on_warning(warning)
        return event

    async def _abort(self, run_id: str) -> None:
        # A conflict means the turn finished first; there is nothing to stop.
        with contextlib.suppress(ConflictError):
            await self._deps.abort_run(self._chat, run_id)

    async def _recover_run(self, run_id: str) -> AsyncGenerator[StreamEvent, None]:
        self._recovered_run = run_id
        if self._abort_requested:
            # Named by a 409 rather than a run event: the requested abort goes out now.
            await self._abort(run_id)
        run = await self._wait_for_run(run_id)
        if run.status == "failed":
            raise StreamError(run.error or f"Run {run_id} failed", code="run_failed", run_id=run_id)
        parts: list[HistoryPart] = []
        later: dict[str, HistoryPart] = {}
        page = await self._deps.history(self._chat)
        async for part in page:
            place = classify(part, run)
            if place == "later":
                answered = later_tool_result(part)
                if answered is not None:
                    later[answered] = part
                continue
            if place == "stop":
                break
            parts.insert(0, part)
        self._result = recovered_result(run, parts, self._accumulator, later)
        yield RecoveredEvent(self._result)

    async def _wait_for_run(self, run_id: str) -> RunInspection:
        """Poll until the run is no longer running, backing off."""
        deadline = time.monotonic() + self._recovery_timeout
        wait = FIRST_POLL
        while True:
            if self._closed:
                raise StreamError("The stream was closed", code="closed", run_id=run_id)
            run = await self._deps.get_run(run_id)
            if is_finished(run):
                return run
            if time.monotonic() + wait > deadline:
                raise StreamError(
                    f"Run {run_id} was still running after {self._recovery_timeout}s",
                    code="recovery_timeout",
                    run_id=run_id,
                )
            await self._deps.transport.sleep(wait)
            wait = min(wait * 2, MAX_POLL)
