# Generated from src/twigg/_async/responses.py by scripts/unasync.py. Do not edit.
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal

from .._generated.models import AbortAccepted
from .._shared.options import ReasoningEffort
from .._shared.request import RequestOptions, compact
from .._shared.result import TwiggWarning
from .._shared.tools import Tool, ToolHandler
from ..errors import TwiggError
from .resources import Aborts, Chats, Id, Runs
from .runner import ToolRunner
from .stream import ResponseStream, StreamDeps
from .transport import Transport


class Responses:
    def __init__(
        self,
        transport: Transport,
        chats: Chats,
        runs: Runs,
        on_warning: Callable[[TwiggWarning], None] | None,
        model: str | None = None,
    ) -> None:
        self._model = model
        self._aborts = Aborts(transport)
        self._deps = StreamDeps(
            transport=transport,
            get_run=lambda run_id: runs.get(run_id),
            history=lambda chat_id: chats.history(chat_id),
            abort_run=lambda chat_id, run_id: self._aborts.abort(chat_id, run_id=run_id),
            on_warning=on_warning,
        )

    def stream(
        self,
        chat_id: Id,
        *,
        model: str | None = None,
        input: Sequence[Any],
        tools: Sequence[Any] | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        retry_of: Id | None = None,
        recover: bool = True,
        idle_timeout: float = 300.0,
        recovery_timeout: float = 600.0,
        options: RequestOptions | None = None,
    ) -> ResponseStream:
        """Submit a prompt or tool results and stream the model's answer. Nothing is sent until
        the stream is iterated or `final()` is called.

        Each submission carries an idempotency key, generated when absent. If the connection
        drops, the turn carries on server-side and `final()` recovers its result from the run
        and history. `tools` are definitions or `@tool` objects."""
        body = compact(
            model=self._resolve_model(model),
            input=list(input),
            tools=None if tools is None else list(tools),
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            user_metadata=user_metadata,
            idempotency_key=idempotency_key,
            retry_of=None if retry_of is None else str(retry_of),
        )
        return ResponseStream(
            self._deps,
            str(chat_id),
            body,
            recover=recover,
            idle_timeout=idle_timeout,
            recovery_timeout=recovery_timeout,
            options=options,
        )

    create = stream

    def retry(
        self,
        chat_id: Id,
        run_id: Id,
        *,
        model: str | None = None,
        tools: Sequence[Any] | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        recover: bool = True,
        options: RequestOptions | None = None,
    ) -> ResponseStream:
        """Retry the chat's latest failed run without adding input. Pass the model and any
        request-level tools again; the retry uses the current configuration."""
        return self.stream(
            chat_id,
            model=model,
            input=[],
            tools=tools,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            retry_of=run_id,
            recover=recover,
            options=options,
        )

    def run_tools(
        self,
        chat_id: Id,
        *,
        model: str | None = None,
        input: Sequence[Any],
        tools: Sequence[Tool] = (),
        handlers: Mapping[str, ToolHandler] | None = None,
        max_iterations: int = 20,
        tool_concurrency: int = 8,
        on_tool_error: Literal["send", "throw"] = "send",
        idempotency_key: str | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        recover: bool = True,
        options: RequestOptions | None = None,
    ) -> ToolRunner:
        """Run the tool loop: stream a turn, run the tools it calls, submit their results, and
        repeat until the model answers without calling more.

        `tools` are sent with every turn and run locally; `handlers` answer tools published to
        the namespace, by name. A tool that raises goes back to the model as an error result
        unless `on_tool_error="throw"`. Turn `n` is submitted with `f"{idempotency_key}:{n}"`,
        so a loop restarted with the same key recovers turns that already ran."""
        request: dict[str, Any] = {
            "model": self._resolve_model(model),
            "input": list(input),
            "max_tokens": max_tokens,
            "reasoning_effort": reasoning_effort,
            "user_metadata": user_metadata,
        }
        return ToolRunner(
            self,
            str(chat_id),
            request,
            tools=tools,
            handlers=handlers or {},
            max_iterations=max_iterations,
            tool_concurrency=tool_concurrency,
            on_tool_error=on_tool_error,
            idempotency_key=idempotency_key,
            stream_options={"recover": recover, "options": options},
        )

    def _resolve_model(self, model: str | None) -> str:
        """The request's model, else the client's default."""
        resolved = model or self._model
        if not resolved:
            raise TwiggError(
                "No model. Pass `model` with the request, in the chat's defaults, or to Twigg().",
                code="missing_model",
            )
        return resolved

    def abort(
        self, chat_id: Id, *, run_id: Id | None = None, options: RequestOptions | None = None
    ) -> AbortAccepted:
        """Stop the chat's turn in progress. Pass `run_id` to abort only that run, so a late
        abort cannot stop a newer turn."""
        return self._aborts.abort(chat_id, run_id=run_id, options=options)
