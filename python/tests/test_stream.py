from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

import httpx
import pytest

from twigg import (
    APIConnectionError,
    DeltaEvent,
    InsufficientBalanceError,
    RecoveredEvent,
    StreamError,
)

from .helpers import (
    CHAT,
    RUN,
    RUN_EVENT,
    api_error,
    done_event,
    history_page,
    json_response,
    part,
    run_record,
    setup,
    sse_response,
    sse_text,
    text_turn,
)

PROMPT: dict[str, Any] = {"model": "claude-opus-5", "input": [{"type": "prompt", "text": "Hi"}]}


def test_sends_nothing_until_used_then_resolves_the_result() -> None:
    twigg, api, _ = setup()
    stream = twigg.responses.stream(CHAT, **PROMPT)
    assert api.requests == []
    api.reply(sse_response(text_turn("Hello there")))
    result = stream.final()
    assert result.run_id == RUN
    assert result.text == "Hello there"
    assert result.stop_reason == "end_turn"
    assert result.cost == Decimal("0.0010")
    assert result.recovered is False
    assert api.last.method == "POST"
    assert api.last.url.path == f"/api/v1/chats/{CHAT}/responses"
    assert api.last.headers["accept"] == "text/event-stream"


def test_generates_an_idempotency_key_and_keeps_a_given_one() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(text_turn()), sse_response(text_turn()))
    twigg.responses.stream(CHAT, **PROMPT).final()
    assert re.fullmatch(r"[0-9a-f-]{36}", api.body(0)["idempotency_key"])
    twigg.responses.stream(CHAT, **PROMPT, idempotency_key="mine").final()
    assert api.body(1)["idempotency_key"] == "mine"


def test_every_iteration_sees_every_event() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(text_turn("Hi")))
    with twigg.responses.stream(CHAT, **PROMPT) as stream:
        first = [e.event for e in stream]
        second = [e.event for e in stream]
        assert stream.run_id == RUN
    assert first == ["run", "config_warnings", "block_start", "delta", "block_stop", "done"]
    assert second == first


def test_text_stream_and_tool_calls_helpers() -> None:
    twigg, api, _ = setup()
    events: list[tuple[str, Any]] = [
        RUN_EVENT,
        ("block_start", {"kind": "text"}),
        ("delta", {"kind": "text", "text": "Let me "}),
        ("delta", {"kind": "text", "text": "look"}),
        ("block_start", {"kind": "tool_call", "tool_use_id": "t1", "tool_name": "read_file"}),
        ("delta", {"kind": "tool_input", "text": '{"path":'}),
        ("delta", {"kind": "tool_input", "text": '"a.txt"}'}),
        ("block_stop", {}),
        done_event(
            stop_reason="tool_use",
            pending_tool_calls=[{"tool_use_id": "t1", "tool_name": "read_file"}],
        ),
    ]
    api.reply(sse_response(sse_text(events)))
    stream = twigg.responses.stream(CHAT, **PROMPT)
    assert "".join(stream.text_stream) == "Let me look"
    assert [c.input for c in stream.tool_calls] == [{"path": "a.txt"}]
    result = stream.final()
    assert [c.id for c in result.pending_tool_calls] == ["t1"]
    assert result.pending_tool_calls[0].raw_input == '{"path":"a.txt"}'


def test_passes_warnings_to_the_client_hook() -> None:
    seen: list[Any] = []
    twigg, api, _ = setup(on_warning=seen.append)
    warning = {"code": "global_instruction_replaced", "namespace": "acme"}
    api.reply(
        sse_response(
            sse_text([RUN_EVENT, ("config_warnings", {"warnings": [warning]}), done_event()])
        )
    )
    result = twigg.responses.stream(CHAT, **PROMPT).final()
    assert [(w.source, w.code) for w in seen] == [("config", "global_instruction_replaced")]
    assert result.warnings == seen


def test_raises_the_http_error_when_the_stream_never_opens() -> None:
    twigg, api, _ = setup()
    api.reply(api_error(402, "payment_required"))
    stream = twigg.responses.stream(CHAT, **PROMPT)
    with pytest.raises(InsufficientBalanceError):
        stream.final()
    with pytest.raises(InsufficientBalanceError):
        _ = stream.run_id


def test_retries_a_503_with_the_same_idempotency_key() -> None:
    twigg, api, _ = setup()
    api.reply(api_error(503, "unavailable"), sse_response(text_turn()))
    twigg.responses.stream(CHAT, **PROMPT).final()
    assert len(api.requests) == 2
    assert api.body(0) == api.body(1)


def test_an_error_event_is_yielded_then_raised() -> None:
    twigg, api, _ = setup()
    api.reply(
        sse_response(
            sse_text([RUN_EVENT, ("error", {"code": "external_service_error", "message": "down"})])
        )
    )
    seen: list[str] = []
    with pytest.raises(StreamError) as caught:
        for event in twigg.responses.stream(CHAT, **PROMPT):
            seen.append(event.event)
    assert seen == ["run", "error"]
    assert (caught.value.code, caught.value.run_id) == ("external_service_error", RUN)


def test_recovers_from_a_drop_mid_turn() -> None:
    twigg, api, _ = setup()
    usage = {
        "input_tokens": 9,
        "output_tokens": 4,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
    }
    api.reply(
        sse_response(
            sse_text(
                [
                    RUN_EVENT,
                    ("block_start", {"kind": "text"}),
                    ("delta", {"kind": "text", "text": "Hal"}),
                ]
            ),
            drop=True,
        ),
        json_response(run_record("running")),
        json_response(run_record("succeeded", cost="0.0042", usage=usage)),
        json_response(
            history_page(
                [
                    part(1, "user", {"type": "prompt", "text": "Hi"}, "2026-10-14T10:00:00Z"),
                    part(2, "assistant", {"type": "reasoning", "text": "think"}),
                    part(3, "assistant", {"type": "message", "text": "Hallo"}),
                    part(
                        4,
                        "assistant",
                        {
                            "type": "tool_call",
                            "tool_use_id": "t9",
                            "tool_name": "lookup",
                            "arguments": '{"q":1}',
                        },
                    ),
                ],
                has_more=True,
            )
        ),
    )
    stream = twigg.responses.stream(CHAT, **PROMPT)
    events = list(stream)
    result = stream.final()
    assert result.recovered
    assert (result.text, result.reasoning, result.stop_reason) == ("Hallo", "think", "tool_use")
    assert result.cost == Decimal("0.0042")
    assert [c.input for c in result.pending_tool_calls] == [{"q": 1}]
    assert isinstance(events[-1], RecoveredEvent)
    assert api.paths() == [
        f"/api/v1/chats/{CHAT}/responses",
        f"/api/v1/runs/{RUN}",
        f"/api/v1/runs/{RUN}",
        f"/api/v1/chats/{CHAT}/history",
    ]


def test_resubmits_after_an_early_drop_and_recovers_from_the_409() -> None:
    twigg, api, _ = setup()
    message = f"idempotency key 'k' was already used; it belongs to run {RUN}"
    api.reply(
        httpx.ConnectError("socket hang up"),
        json_response({"error": {"code": "conflict", "message": message}}, 409),
        json_response(run_record("cancelled")),
        json_response(history_page([])),
    )
    result = twigg.responses.stream(CHAT, **PROMPT).final()
    assert (result.run_id, result.recovered, result.stop_reason) == (RUN, True, "aborted")
    assert api.body(0) == api.body(1)


def test_a_failed_run_raises_stream_error() -> None:
    twigg, api, _ = setup()
    api.reply(
        sse_response(sse_text([RUN_EVENT]), drop=True),
        json_response(run_record("failed", error="boom")),
    )
    with pytest.raises(StreamError) as caught:
        twigg.responses.stream(CHAT, **PROMPT).final()
    assert (caught.value.code, caught.value.message) == ("run_failed", "boom")


def test_raises_connection_error_when_recovery_is_off() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(sse_text([RUN_EVENT]), drop=True))
    with pytest.raises(APIConnectionError):
        twigg.responses.stream(CHAT, **PROMPT, recover=False).final()


def test_a_silent_connection_counts_as_dropped() -> None:
    twigg, api, _ = setup()
    api.reply(
        sse_response(sse_text([RUN_EVENT]), error=httpx.ReadTimeout("idle")),
        json_response(run_record("succeeded")),
        json_response(history_page([])),
    )
    assert twigg.responses.stream(CHAT, **PROMPT, idle_timeout=0.01).final().recovered


def test_abort_stops_the_run_on_the_server() -> None:
    twigg, api, _ = setup()

    def respond(_: httpx.Request) -> httpx.Response:
        return sse_response(sse_text([RUN_EVENT, done_event(stop_reason="aborted")]))

    api.reply(respond, json_response({"run_id": RUN, "chat_id": CHAT, "status": "aborting"}, 202))
    stream = twigg.responses.stream(CHAT, **PROMPT)
    stream.abort()
    assert stream.final().stop_reason == "aborted"
    assert api.requests[1].url.path == f"/api/v1/chats/{CHAT}/abort"
    assert api.requests[1].url.params["run_id"] == RUN


def test_retry_submits_no_input_with_retry_of() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(text_turn()))
    twigg.responses.retry(CHAT, RUN, model="claude-opus-5").final()
    assert api.body()["input"] == []
    assert api.body()["retry_of"] == RUN


def test_deltas_are_typed() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(text_turn("Yo")))
    deltas = [e for e in twigg.responses.stream(CHAT, **PROMPT) if isinstance(e, DeltaEvent)]
    assert [(d.kind, d.text) for d in deltas] == [("text", "Yo")]


EXTERNAL = "/api/v1/chats/external/%2B447700"


def test_a_chat_by_external_id_submits_and_recovers_through_the_external_routes() -> None:
    twigg, api, _ = setup()
    api.reply(
        sse_response(sse_text([RUN_EVENT]), drop=True),
        json_response(run_record("succeeded", completed_at="2026-10-14T10:00:05Z")),
        json_response(history_page([])),
    )
    result = twigg.responses.stream_by_external_id(
        "+447700", chat={"namespace": "acme"}, **PROMPT
    ).final()
    assert (result.run_id, result.chat_id, result.recovered) == (RUN, CHAT, True)
    assert [r.url.raw_path.split(b"?")[0] for r in api.requests] == [
        f"{EXTERNAL}/responses".encode(),
        f"/api/v1/runs/{RUN}".encode(),
        f"{EXTERNAL}/history".encode(),
    ]
    assert api.body(0)["chat"] == {"namespace": "acme"}


def test_a_chat_handle_by_external_id_sends_and_aborts_by_external_id() -> None:
    twigg, api, _ = setup()

    def respond(_: httpx.Request) -> httpx.Response:
        return sse_response(sse_text([RUN_EVENT, done_event(stop_reason="aborted")]))

    api.reply(
        sse_response(text_turn()),
        respond,
        json_response({"run_id": RUN, "chat_id": CHAT, "status": "aborting"}, 202),
        json_response(history_page([])),
    )
    chat = twigg.chat_by_external_id("+447700", chat={"namespace": "wa"}, model="m")
    chat.send("Hi", system="Be brief.")
    assert api.last.url.raw_path == f"{EXTERNAL}/responses".encode()
    assert api.body()["chat"] == {"namespace": "wa"}
    assert api.body()["system"] == "Be brief."
    stream = chat.stream("Again")
    stream.abort()
    assert stream.final().stop_reason == "aborted"
    assert api.requests[2].url.raw_path.startswith(f"{EXTERNAL}/abort?".encode())
    chat.history(after_ordinal=-1)
    assert api.last.url.raw_path.startswith(f"{EXTERNAL}/history?".encode())
