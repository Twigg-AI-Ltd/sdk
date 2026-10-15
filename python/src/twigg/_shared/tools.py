"""Tools with typed, validated input. The input schema comes from the function's type hints, or
from a single pydantic model parameter, or is given as plain JSON Schema."""

from __future__ import annotations

import inspect
import json
import typing
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, overload

from pydantic import BaseModel, ValidationError, create_model

from .result import ResponseResult, StopReason, ToolCall

TrustLevel = Literal["trusted", "customer_data", "untrusted"]


@dataclass(frozen=True)
class ToolContext:
    """What a tool sees besides its input. Declare a parameter annotated `ToolContext` to get it."""

    call: ToolCall
    chat_id: str
    run_id: str


#: A handler for a tool already published to the namespace, matched by name. May be async.
ToolHandler = Callable[[Any, ToolContext], Any]


@dataclass(frozen=True)
class ToolResult:
    """A tool result with media, an error flag or a trust level. Plain strings and JSON
    also work."""

    text: str = ""
    media: list[Mapping[str, Any]] = field(default_factory=lambda: list[Mapping[str, Any]]())
    is_error: bool = False
    #: How far the result is trusted, driving how strictly Twigg sanitises it.
    trust: TrustLevel | None = None


class Tool:
    """A tool the model can call: its definition, input validation, and the function to run."""

    def __init__(
        self,
        name: str,
        fn: Callable[..., Any],
        *,
        input_schema: Mapping[str, Any] | None = None,
        input_model: type[BaseModel] | None = None,
        description: str | None = None,
        strict: bool | None = None,
    ) -> None:
        if input_schema is None and input_model is None:
            raise TypeError(f"Tool {name}: pass input_schema or input_model")
        self.name = name
        self._fn = fn
        self._model = input_model
        self._spread = False
        self._context_param: str | None = None
        schema = dict(input_schema) if input_schema is not None else _schema_of(input_model)
        definition: dict[str, Any] = {
            "name": name,
            "description": description,
            "input_schema": schema,
        }
        if strict is not None:
            definition["strict"] = strict
        #: The definition sent to Twigg: name, description and JSON Schema.
        self.definition = definition
        #: Whether the function is `async def`. Plain functions run in a worker thread on the
        #: async client, so they cannot block its event loop.
        self.is_async = inspect.iscoroutinefunction(fn)

    def parse(self, value: Any) -> tuple[Literal[True], Any] | tuple[Literal[False], str]:
        """Validate the model's arguments: `(True, value)` or `(False, message)`."""
        if self._model is None:
            return True, value
        try:
            return True, self._model.model_validate(value)
        except ValidationError as error:
            return False, "; ".join(
                f"{'.'.join(str(p) for p in issue['loc'])}: {issue['msg']}"
                if issue["loc"]
                else issue["msg"]
                for issue in error.errors()
            )

    def call(self, value: Any, context: ToolContext) -> Any:
        """Run the function on validated input. Returns an awaitable for an async function."""
        kwargs: dict[str, Any] = {}
        if self._context_param:
            kwargs[self._context_param] = context
        if self._spread and isinstance(value, BaseModel):
            kwargs.update({name: getattr(value, name) for name in type(value).model_fields})
            return self._fn(**kwargs)
        return self._fn(value, **kwargs)

    def __repr__(self) -> str:
        return f"Tool({self.name!r})"


@overload
def tool(fn: Callable[..., Any], /) -> Tool: ...
@overload
def tool(
    *, name: str | None = None, description: str | None = None, strict: bool | None = None
) -> Callable[[Callable[..., Any]], Tool]: ...
def tool(
    fn: Callable[..., Any] | None = None,
    /,
    *,
    name: str | None = None,
    description: str | None = None,
    strict: bool | None = None,
) -> Tool | Callable[[Callable[..., Any]], Tool]:
    """Turn a function into a tool. Its parameters become the input schema, or a single pydantic
    model parameter does; a parameter annotated `ToolContext` receives the call's context. The
    docstring is the description unless one is given."""

    def wrap(fn: Callable[..., Any]) -> Tool:
        hints = typing.get_type_hints(fn)
        signature = inspect.signature(fn)
        context_param: str | None = None
        params: dict[str, tuple[Any, Any]] = {}
        for param in signature.parameters.values():
            annotation = hints.get(param.name, Any)
            if annotation is ToolContext:
                context_param = param.name
                continue
            default = ... if param.default is inspect.Parameter.empty else param.default
            params[param.name] = (annotation, default)
        tool_name = name or fn.__name__
        only = next(iter(params.values()), None)
        is_model = (
            len(params) == 1
            and only is not None
            and inspect.isclass(only[0])
            and issubclass(only[0], BaseModel)
        )
        model: type[BaseModel] = (
            typing.cast("type[BaseModel]", only[0])
            if is_model and only is not None
            else _model_from(tool_name, params)
        )
        made = Tool(
            tool_name,
            fn,
            input_model=model,
            description=description or inspect.getdoc(fn),
            strict=strict,
        )
        made._spread = not is_model
        made._context_param = context_param
        return made

    return wrap(fn) if fn is not None else wrap


def result_fields(output: Any) -> dict[str, Any]:
    """The `tool_result` fields for whatever a tool returned."""
    if isinstance(output, ToolResult):
        fields: dict[str, Any] = {"text": output.text, "is_error": output.is_error}
        if output.media:
            fields["media"] = [dict(m) for m in output.media]
        if output.trust:
            fields["trust"] = output.trust
        return fields
    if isinstance(output, str):
        return {"text": output, "is_error": False}
    if output is None:
        return {"text": "", "is_error": False}
    if isinstance(output, BaseModel):
        return {"text": output.model_dump_json(), "is_error": False}
    return {"text": json.dumps(output, default=str), "is_error": False}


def error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


def _model_from(name: str, params: dict[str, tuple[Any, Any]]) -> type[BaseModel]:
    title = "".join(part.capitalize() for part in name.replace("-", "_").split("_")) + "Input"
    fields: dict[str, Any] = dict(params)
    return create_model(title, **fields)


def _schema_of(model: type[BaseModel] | None) -> dict[str, Any]:
    assert model is not None
    schema = model.model_json_schema()
    # The generated title adds nothing for a model reading the schema.
    schema.pop("title", None)
    return schema


@dataclass
class ToolRunResult:
    """How a tool loop ended."""

    #: The last turn's result.
    result: ResponseResult
    #: Every turn, in order.
    turns: list[ResponseResult]
    #: The model's own stop reason when it stopped; `max_iterations` when the loop hit its
    #: limit; `unhandled_tool_calls` when the model called a tool with no local tool or handler.
    #: The pending calls are then on `result.pending_tool_calls` for the caller to answer.
    stop_reason: StopReason | Literal["max_iterations", "unhandled_tool_calls"]
