"""One test per finding from the first code review (mirroring the TypeScript
review-regressions.test.ts), so none can come back unnoticed."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from twigg import ResponseAccumulator, tool

from .helpers import (
    CHAT,
    RUN,
    RUN_EVENT,
    answer_turn,
    call_turn,
    chat_summary,
    done_event,
    history_page,
    json_response,
    part,
    run_record,
    setup,
    setup_async,
    sse_response,
    sse_text,
)

RUN_A = "0192f0a0-0000-7000-8000-0000000000a0"
RUN_B = "0192f0a0-0000-7000-8000-0000000000a1"
ASK: dict[str, Any] = {"model": "m", "input": [{"type": "prompt", "text": "go"}]}


def conflict(run_id: str) -> httpx.Response:
    message = f"idempotency key 'k' was already used; it belongs to run {run_id}"
    return json_response({"error": {"code": "conflict", "message": message}}, 409)


def at(second: int) -> str:
    return f"2026-10-14T10:00:{second:02d}Z"


def test_replaying_an_older_key_returns_that_turn_not_a_later_one() -> None:
    twigg, api, _ = setup()
    api.reply(
        conflict(RUN_A),
        json_response(run_record("succeeded", id=RUN_A, created_at=at(0), completed_at=at(2))),
        json_response(
            history_page(
                [
                    part(1, "user", {"type": "prompt", "text": "q1"}, at(0)),
                    part(2, "assistant", {"type": "message", "text": "first answer"}, at(1)),
                    part(3, "user", {"type": "prompt", "text": "q2"}, at(3)),
                    part(4, "assistant", {"type": "message", "text": "second answer"}, at(4)),
                ]
            )
        ),
    )
    replay = twigg.responses.stream(CHAT, **ASK, idempotency_key="k1").final()
    assert (replay.run_id, replay.text, replay.recovered) == (RUN_A, "first answer", True)


def test_a_restarted_tool_loop_does_not_run_tools_that_already_ran() -> None:
    runs: list[str] = []

    @tool
    def step(n: str) -> str:
        runs.append(n)
        return f"did {n}"

    result_a = {
        "type": "tool_result",
        "tool_use_id": "call-a",
        "tool_name": "step",
        "text": "did A",
        "is_error": False,
        "trust": "customer_data",
    }
    page = history_page(
        [
            part(1, "user", {"type": "prompt", "text": "go"}, at(0)),
            part(
                2,
                "assistant",
                {
                    "type": "tool_call",
                    "tool_use_id": "call-a",
                    "tool_name": "step",
                    "arguments": '{"n":"A"}',
                },
                at(1),
            ),
            part(3, "user", result_a, at(3)),
            part(
                4,
                "assistant",
                {
                    "type": "tool_call",
                    "tool_use_id": "call-b",
                    "tool_name": "step",
                    "arguments": '{"n":"B"}',
                },
                at(5),
            ),
        ]
    )
    twigg, api, _ = setup()
    api.reply(
        # Turn 0 already ran, and its call A was answered: recovered, nothing to run.
        conflict(RUN_A),
        json_response(run_record("succeeded", id=RUN_A, created_at=at(0), completed_at=at(2))),
        json_response(page),
        # Turn 1 already ran too; its call B never got a result.
        conflict(RUN_B),
        json_response(run_record("succeeded", id=RUN_B, created_at=at(4), completed_at=at(6))),
        json_response(page),
        answer_turn("all done"),
    )
    outcome = twigg.responses.run_tools(CHAT, **ASK, tools=[step], idempotency_key="job").final()
    assert outcome.result.text == "all done"
    assert runs == ["B"]
    assert [api.body(i)["idempotency_key"] for i in (0, 3, 6)] == ["job-0", "job-1", "job-2"]
    assert api.body(3)["input"] == [result_a]


def test_a_throwing_hook_fails_the_stream_instead_of_looking_like_a_drop() -> None:
    def explode(_: object) -> None:
        raise RuntimeError("render failed")

    twigg, api, _ = setup(on_warning=explode)
    warning = {"code": "global_instruction_replaced", "namespace": "acme"}
    api.reply(
        sse_response(
            sse_text([RUN_EVENT, ("config_warnings", {"warnings": [warning]}), done_event()])
        )
    )
    with pytest.raises(RuntimeError, match="render failed"):
        twigg.responses.stream(CHAT, **ASK).final()
    assert not any(p.startswith("/api/v1/runs/") for p in api.paths())


def test_a_repeated_warning_is_reported_once() -> None:
    seen: list[object] = []
    twigg, api, _ = setup(on_warning=seen.append)
    warning = {"code": "global_instruction_replaced", "namespace": "acme", "message": "replaced"}
    api.reply(
        sse_response(
            sse_text(
                [
                    RUN_EVENT,
                    ("config_warnings", {"warnings": [warning]}),
                    ("compacting", {"blocks": 1, "in_progress_elsewhere": 0}),
                    ("config_warnings", {"warnings": [warning]}),
                    done_event(),
                ]
            )
        )
    )
    result = twigg.responses.stream(CHAT, **ASK).final()
    assert len(seen) == 1
    assert len(result.warnings) == 1


def test_reading_only_the_run_id_does_not_raise_for_a_later_failure() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(sse_text([RUN_EVENT, ("error", {"code": "x", "message": "failed"})])))
    assert twigg.responses.stream(CHAT, **ASK).run_id == RUN


class Gated(httpx.AsyncByteStream):
    def __init__(self, gate: asyncio.Event, text: str) -> None:
        self.gate = gate
        self.text = text

    async def __aiter__(self) -> AsyncIterator[bytes]:
        await self.gate.wait()
        yield self.text.encode()


async def test_abort_called_twice_before_the_run_is_named_sends_one_request() -> None:
    gate = asyncio.Event()
    twigg, api, _ = setup_async()
    body = sse_text([RUN_EVENT, done_event(stop_reason="aborted")])
    api.reply(
        httpx.Response(200, stream=Gated(gate, body)),
        json_response({"run_id": RUN, "chat_id": CHAT, "status": "aborting"}, 202),
    )
    stream = twigg.responses.stream(CHAT, **ASK)
    first = asyncio.create_task(stream.abort())
    second = asyncio.create_task(stream.abort())
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(first, second)
    assert (await stream.final()).stop_reason == "aborted"
    assert len([p for p in api.paths() if p.endswith("/abort")]) == 1


def test_an_abort_before_a_409_names_the_run_goes_out_once_it_is_named() -> None:
    twigg, api, _ = setup()
    api.reply(
        conflict(RUN),
        json_response({"run_id": RUN, "chat_id": CHAT, "status": "aborting"}, 202),
        json_response(run_record("cancelled")),
        json_response(history_page([])),
    )
    stream = twigg.responses.stream(CHAT, **ASK, idempotency_key="k")
    stream.abort()
    stream.abort()
    assert stream.final().stop_reason == "aborted"
    aborts = [r for r in api.requests if r.url.path.endswith("/abort")]
    assert len(aborts) == 1
    assert aborts[0].url.params["run_id"] == RUN


@pytest.mark.parametrize("concurrency", [0, -3, 1.5])
async def test_a_non_positive_or_fractional_concurrency_still_runs_every_tool(
    concurrency: Any,
) -> None:
    @tool
    async def echo() -> str:
        return "ok"

    twigg, api, _ = setup_async()
    api.reply(call_turn([("t1", "echo", "{}"), ("t2", "echo", "{}")]), answer_turn("fine"))
    outcome = await twigg.responses.run_tools(
        CHAT, **ASK, tools=[echo], tool_concurrency=concurrency
    ).final()
    assert outcome.result.text == "fine"
    submitted = api.body(1)["input"]
    assert len(submitted) == 2
    assert None not in submitted


def test_a_pending_call_with_no_streamed_block_says_so() -> None:
    accumulator = ResponseAccumulator()
    accumulator.push(*RUN_EVENT)
    name, data = done_event(
        stop_reason="tool_use", pending_tool_calls=[{"tool_use_id": "t1", "tool_name": "x"}]
    )
    accumulator.push(name, data)
    call = accumulator.result().pending_tool_calls[0]
    assert call.input_error == "The stream carried no arguments for this call"


def test_a_delta_without_block_start_starts_a_block() -> None:
    accumulator = ResponseAccumulator()
    accumulator.push(*RUN_EVENT)
    accumulator.push("delta", {"kind": "text", "text": "hi"})
    accumulator.push(*done_event())
    assert accumulator.result().text == "hi"


def test_tool_loop_keys_use_only_characters_the_api_accepts() -> None:
    # The API allows letters, digits and `-._~` in idempotency keys; `job:0` is a 422.
    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "step", "{}")]), answer_turn("done"))

    @tool
    def step() -> str:
        return "ok"

    twigg.responses.run_tools(CHAT, **ASK, tools=[step], idempotency_key="job").final()
    keys = [api.body(i)["idempotency_key"] for i in (0, 1)]
    assert all(re.fullmatch(r"[A-Za-z0-9._~-]+", key) for key in keys), keys


def test_reads_an_external_id_the_specs_pattern_misleads_pydantic_about() -> None:
    # The spec's pattern has `[&--0]`, a range in ECMAScript and a set difference to pydantic.
    twigg, api, _ = setup()
    api.reply(json_response({**chat_summary(1), "external_id": "+447700"}))
    assert twigg.chats.get_by_external_id("+447700").external_id == "+447700"
