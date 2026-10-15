"""The keyword arguments a chat's turns accept, typed so a misspelt field is a type error rather
than a request the API rejects."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from typing_extensions import TypedDict

from .request import RequestOptions
from .tools import Tool, ToolHandler

ReasoningEffort = Literal["off", "low", "medium", "high", "x_high", "max"]


class TurnFields(TypedDict, total=False):
    """Request fields and stream options for one turn. Any left out come from the chat's
    defaults, and `model` finally from the client."""

    model: str
    #: Tool definitions or `@tool` objects, offered to the model for this turn.
    tools: Sequence[Any]
    max_tokens: int
    reasoning_effort: ReasoningEffort
    user_metadata: Mapping[str, Any]
    #: Generated when absent. Reusing one recovers the turn it started instead of repeating it.
    idempotency_key: str
    #: Rebuild the result from the run and history if the connection drops. Default true.
    recover: bool
    #: Seconds of silence before the connection counts as dropped. Default 300.
    idle_timeout: float
    #: Seconds to wait for a dropped turn to finish while recovering it. Default 600.
    recovery_timeout: float
    options: RequestOptions


class ToolLoopFields(TypedDict, total=False):
    """Options for `run_tools`: the turn's request fields plus the loop's own."""

    model: str
    #: Sent with every turn and run locally.
    tools: Sequence[Tool]
    #: Handlers for tools published to the namespace, by name.
    handlers: Mapping[str, ToolHandler]
    #: Model turns before stopping. Default 20.
    max_iterations: int
    #: Tool calls run at once within a turn. Default 8.
    tool_concurrency: int
    #: `send` (default) returns a tool's exception to the model; `throw` stops the loop.
    on_tool_error: Literal["send", "throw"]
    #: Turn `n` is submitted as `f"{idempotency_key}:{n}"`, so a restarted loop recovers.
    idempotency_key: str
    max_tokens: int
    reasoning_effort: ReasoningEffort
    user_metadata: Mapping[str, Any]
    recover: bool
    options: RequestOptions


class RetryFields(TypedDict, total=False):
    """Options for retrying a failed run. The retry adds no input."""

    model: str
    tools: Sequence[Any]
    max_tokens: int
    reasoning_effort: ReasoningEffort
    recover: bool
    options: RequestOptions


def pick(fields: Mapping[str, Any], allowed: type) -> dict[str, Any]:
    """The entries of `fields` that the TypedDict `allowed` declares. A chat's defaults are
    shared by every kind of call, and not every call takes every field."""
    keys: frozenset[str] = getattr(allowed, "__optional_keys__", frozenset())
    return {k: v for k, v in fields.items() if k in keys}
