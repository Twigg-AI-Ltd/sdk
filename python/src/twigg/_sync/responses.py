# Generated from src/twigg/_async/responses.py by scripts/unasync.py. Do not edit.
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal

from typing_extensions import Unpack

from .._generated.models import AbortAccepted
from .._shared.options import ReasoningEffort, RetryFields, ToolLoopFields, TurnFields
from .._shared.request import RequestOptions, compact
from .._shared.result import TwiggWarning
from .._shared.tools import Tool, ToolHandler
from ..errors import TwiggError
from .resources import Aborts, ChatRef, Chats, ExternalRef, Id, Runs
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
            history=lambda chat: chats._history_at(chat, {}, None),
            abort_run=lambda chat, run_id: self._aborts.abort(chat, run_id=run_id),
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
        system: str | None = None,
        wait_for_pending_tool_calls: int | None = None,
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
        and history. `tools` are definitions or `@tool` objects.

        `system` is appended to the configured instructions for this request only; it is not
        stored, so send it with every turn it applies to. `wait_for_pending_tool_calls` refuses,
        with 409 `tool_calls_pending`, a submission that would close an unanswered tool call
        younger than that many seconds."""
        return self._stream(
            chat_id,
            model=model,
            input=input,
            tools=tools,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            user_metadata=user_metadata,
            system=system,
            wait_for_pending_tool_calls=wait_for_pending_tool_calls,
            idempotency_key=idempotency_key,
            retry_of=retry_of,
            recover=recover,
            idle_timeout=idle_timeout,
            recovery_timeout=recovery_timeout,
            options=options,
        )

    create = stream

    def stream_by_external_id(
        self,
        external_id: str,
        *,
        input: Sequence[Any],
        chat: Mapping[str, Any] | None = None,
        **fields: Unpack[TurnFields],
    ) -> ResponseStream:
        """`stream` for the chat holding `external_id`, your own identifier for it such as a
        phone number, creating the chat on first use: one request however new the chat is.
        `chat` (namespace, title, description, user_metadata) says how to create it; on an
        existing chat it is ignored, except that a `namespace` differing from the chat's is
        refused with 409 `external_id_namespace_mismatch`. Recovery and abort also address the
        chat by its external id."""
        return self._stream(ExternalRef(external_id), input=input, chat=chat, **fields)

    create_by_external_id = stream_by_external_id

    def _stream(
        self,
        target: ChatRef,
        *,
        input: Sequence[Any],
        chat: Mapping[str, Any] | None = None,
        model: str | None = None,
        tools: Sequence[Any] | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        system: str | None = None,
        wait_for_pending_tool_calls: int | None = None,
        idempotency_key: str | None = None,
        retry_of: Id | None = None,
        recover: bool = True,
        idle_timeout: float = 300.0,
        recovery_timeout: float = 600.0,
        options: RequestOptions | None = None,
    ) -> ResponseStream:
        body = compact(
            model=self._resolve_model(model),
            input=list(input),
            tools=None if tools is None else list(tools),
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            user_metadata=user_metadata,
            system=system,
            wait_for_pending_tool_calls=wait_for_pending_tool_calls,
            idempotency_key=idempotency_key,
            retry_of=None if retry_of is None else str(retry_of),
            chat=chat,
        )
        return ResponseStream(
            self._deps,
            target if isinstance(target, ExternalRef) else str(target),
            body,
            recover=recover,
            idle_timeout=idle_timeout,
            recovery_timeout=recovery_timeout,
            options=options,
        )

    def retry(
        self,
        chat_id: Id,
        run_id: Id,
        *,
        model: str | None = None,
        tools: Sequence[Any] | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        system: str | None = None,
        recover: bool = True,
        options: RequestOptions | None = None,
    ) -> ResponseStream:
        """Retry the chat's latest failed run without adding input. Pass the model, any
        request-level tools and any `system` prompt again; the retry uses the current
        configuration."""
        return self._stream(
            chat_id,
            model=model,
            input=[],
            tools=tools,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            system=system,
            retry_of=run_id,
            recover=recover,
            options=options,
        )

    def retry_by_external_id(
        self, external_id: str, run_id: Id, **fields: Unpack[RetryFields]
    ) -> ResponseStream:
        """`retry` for the chat holding `external_id`."""
        return self._stream(ExternalRef(external_id), input=[], retry_of=run_id, **fields)

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
        system: str | None = None,
        wait_for_pending_tool_calls: int | None = None,
        recover: bool = True,
        options: RequestOptions | None = None,
    ) -> ToolRunner:
        """Run the tool loop: stream a turn, run the tools it calls, submit their results, and
        repeat until the model answers without calling more.

        `tools` are sent with every turn and run locally; `handlers` answer tools published to
        the namespace, by name. A tool that raises goes back to the model as an error result
        unless `on_tool_error="throw"`. Turn `n` is submitted with `f"{idempotency_key}-{n}"`,
        so a loop restarted with the same key recovers turns that already ran."""
        return self._run_tools(
            chat_id,
            model=model,
            input=input,
            tools=tools,
            handlers=handlers,
            max_iterations=max_iterations,
            tool_concurrency=tool_concurrency,
            on_tool_error=on_tool_error,
            idempotency_key=idempotency_key,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            user_metadata=user_metadata,
            system=system,
            wait_for_pending_tool_calls=wait_for_pending_tool_calls,
            recover=recover,
            options=options,
        )

    def run_tools_by_external_id(
        self,
        external_id: str,
        *,
        input: Sequence[Any],
        chat: Mapping[str, Any] | None = None,
        **fields: Unpack[ToolLoopFields],
    ) -> ToolRunner:
        """`run_tools` for the chat holding `external_id`, creating it on the first turn as
        `chat` describes."""
        return self._run_tools(ExternalRef(external_id), input=input, chat=chat, **fields)

    def _run_tools(
        self,
        target: ChatRef,
        *,
        input: Sequence[Any],
        chat: Mapping[str, Any] | None = None,
        model: str | None = None,
        tools: Sequence[Tool] = (),
        handlers: Mapping[str, ToolHandler] | None = None,
        max_iterations: int = 20,
        tool_concurrency: int = 8,
        on_tool_error: Literal["send", "throw"] = "send",
        idempotency_key: str | None = None,
        max_tokens: int | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        system: str | None = None,
        wait_for_pending_tool_calls: int | None = None,
        recover: bool = True,
        options: RequestOptions | None = None,
    ) -> ToolRunner:
        request: dict[str, Any] = {
            "model": self._resolve_model(model),
            "input": list(input),
            "max_tokens": max_tokens,
            "reasoning_effort": reasoning_effort,
            "user_metadata": user_metadata,
            "system": system,
            "wait_for_pending_tool_calls": wait_for_pending_tool_calls,
            "chat": chat,
        }
        return ToolRunner(
            self,
            target if isinstance(target, ExternalRef) else str(target),
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

    def abort_by_external_id(
        self, external_id: str, *, run_id: Id | None = None, options: RequestOptions | None = None
    ) -> AbortAccepted:
        """`abort` for the chat holding `external_id`."""
        return self._aborts.abort(ExternalRef(external_id), run_id=run_id, options=options)
