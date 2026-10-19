from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from twigg import Tool, ToolContext, ToolResult, tool

from .helpers import CHAT, answer_turn, call_turn, setup

ASK: dict[str, Any] = {"model": "claude-opus-5", "input": [{"type": "prompt", "text": "go"}]}


@tool
def read_file(path: str) -> str:
    """Read a file."""
    return f"contents of {path}"


class SearchArgs(BaseModel):
    query: str
    limit: int = 5


@tool(name="search")
def search_docs(args: SearchArgs, context: ToolContext) -> dict[str, Any]:
    return {"query": args.query, "limit": args.limit, "call": context.call.id}


def test_derives_the_definition_from_type_hints() -> None:
    assert read_file.definition == {
        "name": "read_file",
        "description": "Read a file.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "title": "Path"}},
            "required": ["path"],
        },
    }


def test_a_single_model_parameter_is_the_schema() -> None:
    schema = search_docs.definition["input_schema"]
    assert schema["properties"].keys() == {"query", "limit"}
    assert schema["required"] == ["query"]


def test_validates_input() -> None:
    assert read_file.parse({"path": "a"})[0] is True
    ok, message = read_file.parse({"path": 3})
    assert ok is False
    assert str(message).startswith("path: ")


def test_accepts_a_plain_json_schema() -> None:
    def echo(value: Any, context: ToolContext) -> Any:
        return value

    lookup = Tool("lookup", echo, input_schema={"type": "object"})
    assert lookup.definition["input_schema"] == {"type": "object"}
    assert lookup.parse({"anything": 1}) == (True, {"anything": 1})


def test_runs_requested_tools_and_stops_when_the_model_answers() -> None:
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "read_file", '{"path":"a.txt"}')]), answer_turn("Done"))
    outcome = twigg.responses.run_tools(
        CHAT, **ASK, tools=[read_file], idempotency_key="job-7"
    ).final()
    assert outcome.stop_reason == "end_turn"
    assert outcome.result.text == "Done"
    assert len(outcome.turns) == 2
    assert api.body(0)["idempotency_key"] == "job-7-0"
    assert api.body(0)["tools"] == [read_file.definition]
    assert api.body(1)["idempotency_key"] == "job-7-1"
    assert api.body(1)["input"] == [
        {
            "type": "tool_result",
            "tool_use_id": "t1",
            "tool_name": "read_file",
            "text": "contents of a.txt",
            "is_error": False,
        }
    ]


def test_passes_context_and_model_arguments() -> None:
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "search", '{"query":"refunds"}')]), answer_turn("ok"))
    twigg.responses.run_tools(CHAT, **ASK, tools=[search_docs]).final()
    assert api.body(1)["input"][0]["text"] == '{"query": "refunds", "limit": 5, "call": "t1"}'


def test_returns_bad_arguments_and_errors_to_the_model() -> None:
    @tool
    def boom() -> None:
        raise RuntimeError("disk full")

    twigg, api, _ = setup()
    api.reply(
        call_turn(
            [
                ("t1", "read_file", '{"path":7}'),
                ("t2", "boom", "{}"),
                ("t3", "read_file", "{not json"),
            ]
        ),
        answer_turn("ok"),
    )
    twigg.responses.run_tools(CHAT, **ASK, tools=[read_file, boom]).final()
    parts = api.body(1)["input"]
    assert [p["is_error"] for p in parts] == [True, True, True]
    assert parts[0]["text"].startswith("Invalid arguments for read_file: path:")
    assert parts[1]["text"] == "RuntimeError: disk full"
    assert parts[2]["text"].startswith("The arguments were not valid JSON")


def test_rethrows_when_asked() -> None:
    @tool
    def boom() -> None:
        raise RuntimeError("x")

    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "boom", "{}")]))
    with pytest.raises(RuntimeError, match="x"):
        twigg.responses.run_tools(CHAT, **ASK, tools=[boom], on_tool_error="throw").final()


def test_handlers_answer_published_tools_without_sending_definitions() -> None:
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "lookup", '{"id":1}')]), answer_turn("ok"))

    def lookup(value: Any, context: ToolContext) -> Any:
        return {"found": value}

    twigg.responses.run_tools(CHAT, **ASK, handlers={"lookup": lookup}).final()
    assert "tools" not in api.body(0)
    assert api.body(1)["input"][0]["text"] == '{"found": {"id": 1}}'


def test_stops_when_a_tool_has_no_handler() -> None:
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "mystery", "{}")]))
    outcome = twigg.responses.run_tools(CHAT, **ASK, tools=[read_file]).final()
    assert outcome.stop_reason == "unhandled_tool_calls"
    assert [c.name for c in outcome.result.pending_tool_calls] == ["mystery"]
    assert len(api.requests) == 1


def test_stops_at_max_iterations() -> None:
    twigg, api, _ = setup()
    api.reply(
        call_turn([("t1", "read_file", '{"path":"a"}')]),
        call_turn([("t2", "read_file", '{"path":"b"}')]),
    )
    outcome = twigg.responses.run_tools(CHAT, **ASK, tools=[read_file], max_iterations=2).final()
    assert outcome.stop_reason == "max_iterations"
    assert len(api.requests) == 2


def test_sends_media_trust_and_error_flags_from_a_tool_result() -> None:
    @tool
    def screenshot() -> ToolResult:
        return ToolResult(
            text="see image",
            media=[{"mime": "image/png", "data_base64": "AAAA"}],
            trust="untrusted",
        )

    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "screenshot", "")]), answer_turn("nice"))
    twigg.responses.run_tools(CHAT, **ASK, tools=[screenshot]).final()
    assert api.body(1)["input"][0] == {
        "type": "tool_result",
        "tool_use_id": "t1",
        "tool_name": "screenshot",
        "text": "see image",
        "is_error": False,
        "trust": "untrusted",
        "media": [{"mime": "image/png", "data_base64": "AAAA"}],
    }


def test_iterating_yields_turn_events_and_results() -> None:
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "read_file", '{"path":"a"}')]), answer_turn("ok"))
    kinds: list[str] = []
    for event in twigg.responses.run_tools(CHAT, **ASK, tools=[read_file]):
        kinds.append(
            f"{event.iteration}:{event.event.event}" if event.type == "event" else event.type
        )
    assert "tool_result" in kinds
    assert [k for k in kinds if k.endswith(":done")] == ["0:done", "1:done"]


def test_the_sync_client_refuses_async_tools() -> None:
    @tool
    async def later() -> str:
        return "x"

    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "later", "{}")]), answer_turn("ok"))
    twigg.responses.run_tools(CHAT, **ASK, tools=[later]).final()
    assert "AsyncTwigg" in api.body(1)["input"][0]["text"]
