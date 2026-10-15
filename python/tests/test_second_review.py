# pyright: reportUnnecessaryTypeIgnoreComment=true
"""One test per finding from the pre-release review, so none can come back unnoticed."""

from __future__ import annotations

import asyncio
import builtins
import subprocess
import sys
import threading
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest

from twigg import (
    APITimeoutError,
    ResponseAccumulator,
    StreamError,
    TurnStarted,
    TwiggError,
    UnknownBlock,
    tool,
)
from twigg._shared.request import retry_delay
from twigg.types import HistoryMessage, UnknownHistoryBody

from .helpers import (
    CHAT,
    RUN,
    RUN_EVENT,
    answer_turn,
    call_turn,
    history_page,
    json_response,
    part,
    run_record,
    setup,
    setup_async,
    sse_response,
    sse_text,
)

ASK: dict[str, Any] = {"model": "claude-opus-5", "input": [{"type": "prompt", "text": "Hi"}]}


# Forward compatibility: a value the API adds later must not break a call that worked before.


def test_a_new_run_status_is_accepted() -> None:
    twigg, api, _ = setup()
    api.reply(json_response(run_record("queued")))
    assert twigg.runs.get(RUN).status == "queued"


def test_a_new_history_part_type_is_kept_not_fatal() -> None:
    twigg, api, _ = setup()
    unknown = {"type": "image_generation", "url": "https://x"}
    api.reply(
        json_response(
            history_page(
                [
                    part(1, "assistant", unknown),
                    part(2, "assistant", {"type": "message", "text": "hi"}),
                ]
            )
        )
    )
    parts = [p.part for p in twigg.chat(CHAT).history(after_ordinal=-1)]
    assert isinstance(parts[0], UnknownHistoryBody)
    assert parts[0].type == "image_generation"
    assert parts[0].model_extra == {"url": "https://x"}
    assert isinstance(parts[1], HistoryMessage)


def test_recovery_waits_out_an_unknown_status_and_skips_unknown_parts() -> None:
    twigg, api, sleeps = setup()
    api.reply(
        sse_response(sse_text([RUN_EVENT]), drop=True),
        json_response(run_record("queued")),
        json_response(run_record("succeeded", completed_at="2026-10-14T10:00:05Z")),
        json_response(
            history_page(
                [
                    part(1, "user", {"type": "prompt", "text": "Hi"}, "2026-10-14T09:59:00Z"),
                    part(2, "assistant", {"type": "hologram", "data": 1}),
                    part(3, "assistant", {"type": "message", "text": "Hallo"}),
                ]
            )
        ),
    )
    result = twigg.responses.stream(CHAT, **ASK).final()
    assert result.recovered
    assert result.text == "Hallo"
    assert len(sleeps) == 1  # "queued" was waited out, not taken for the end of the run


def test_a_response_of_the_wrong_shape_is_a_twigg_error() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({"unexpected": True}))
    with pytest.raises(TwiggError) as caught:
        twigg.runs.get(RUN)
    assert caught.value.code == "invalid_response"


def test_a_non_json_body_is_a_twigg_error() -> None:
    twigg, api, _ = setup()
    api.reply(httpx.Response(200, text="<html>proxy login</html>"))
    with pytest.raises(TwiggError) as caught:
        twigg.models.list()
    assert caught.value.code == "invalid_response"


def test_a_run_event_without_ids_is_a_twigg_error() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(sse_text([("run", {"chat_id": CHAT})])))
    with pytest.raises(TwiggError) as caught:
        twigg.responses.stream(CHAT, **ASK).final()
    assert caught.value.code == "invalid_response"


# Path segments: `..` must never reach URL resolution with the API key attached.


@pytest.mark.parametrize("value", ["..", ".", ""])
def test_refuses_dot_and_empty_path_segments(value: str) -> None:
    twigg, api, _ = setup()
    with pytest.raises(ValueError, match="Invalid path segment"):
        twigg.chats.get(value)
    with pytest.raises(ValueError, match="Invalid path segment"):
        twigg.catalogue.get(f"../../api/v1/usage{value}")
    assert api.requests == []


def test_a_model_name_with_slashes_still_works() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({}))
    with pytest.raises(TwiggError):  # The empty body is not a model; the path is what matters.
        twigg.catalogue.get("openrouter/claude-sonnet-5")
    assert api.last.url.path == "/v1/catalogue/openrouter/claude-sonnet-5"


# Closing a stream from elsewhere, as a cancel button does.


class Blocking(httpx.SyncByteStream, httpx.AsyncByteStream):
    """Sends `first`, then waits until closed, as a socket does when the model is thinking."""

    def __init__(self, first: str) -> None:
        self.first = first.encode()
        self.closed = threading.Event()
        self.aclosed = asyncio.Event()

    def __iter__(self) -> Iterator[bytes]:
        yield self.first
        self.closed.wait(5)
        raise httpx.ReadError("closed")

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self.first
        await asyncio.wait_for(self.aclosed.wait(), 5)
        raise httpx.ReadError("closed")

    def close(self) -> None:
        self.closed.set()

    async def aclose(self) -> None:
        self.aclosed.set()


def test_closing_from_another_thread_stops_the_reader_without_recovery() -> None:
    twigg, api, _ = setup()
    body = Blocking(sse_text([RUN_EVENT]))
    api.reply(httpx.Response(200, stream=body))
    stream = twigg.responses.stream(CHAT, **ASK)
    assert next(iter(stream)).event == "run"
    timer = threading.Timer(0.1, stream.close)
    timer.start()
    started = time.monotonic()
    with pytest.raises(StreamError) as caught:
        stream.final()
    timer.join()
    assert caught.value.code == "closed"
    assert time.monotonic() - started < 2
    assert len(api.requests) == 1  # no runs.get: a close is not a dropped connection


async def test_closing_from_another_task_stops_the_reader_without_recovery() -> None:
    twigg, api, _ = setup_async()
    body = Blocking(sse_text([RUN_EVENT]))
    api.reply(httpx.Response(200, stream=body))
    stream = twigg.responses.stream(CHAT, **ASK)
    assert (await stream.run_id) == RUN
    reader = asyncio.create_task(stream.final())
    await asyncio.sleep(0.05)
    await stream.close()
    with pytest.raises(StreamError) as caught:
        await asyncio.wait_for(reader, 2)
    assert caught.value.code == "closed"
    assert len(api.requests) == 1


def test_a_tool_loop_closes_with_its_block() -> None:
    @tool
    def lookup() -> str:
        return "x"

    twigg, api, _ = setup()
    api.reply(call_turn([("t1", "lookup", "{}")]), answer_turn("done"))
    with twigg.chat(CHAT, model="m").run_tools("Hi", tools=[lookup]) as runner:
        for event in runner:
            if isinstance(event, TurnStarted):
                break
    with pytest.raises(StreamError) as caught:
        runner.final()
    assert caught.value.code == "closed"
    assert len(api.requests) <= 1


# Block kinds added later stay out of the text.


def test_an_unknown_block_kind_is_kept_apart_from_the_text() -> None:
    accumulator = ResponseAccumulator()
    events: list[tuple[str, Any]] = [
        RUN_EVENT,
        ("block_start", {"kind": "text"}),
        ("delta", {"kind": "text", "text": "Hi"}),
        ("block_stop", {}),
        ("block_start", {"kind": "citation"}),
        ("delta", {"kind": "citation", "text": "[1] source"}),
        ("block_stop", {}),
        ("done", {"stop_reason": "end_turn", "pending_tool_calls": []}),
    ]
    for name, data in events:
        accumulator.push(name, data)
    result = accumulator.result()
    assert result.text == "Hi"
    assert result.blocks[1] == UnknownBlock("citation", "[1] source")


# Packaging and names.


def test_importing_raises_no_warnings() -> None:
    subprocess.run([sys.executable, "-W", "error", "-c", "import twigg"], check=True)


def test_the_timeout_error_is_also_the_builtin_one() -> None:
    assert issubclass(APITimeoutError, builtins.TimeoutError)
    assert issubclass(APITimeoutError, TwiggError)


def test_the_client_repr_never_shows_the_api_key() -> None:
    twigg, _, _ = setup(api_key="tw_secret_value")
    assert "tw_secret_value" not in repr(twigg._transport.config)


def test_a_misspelt_field_is_refused() -> None:
    twigg, _, _ = setup()
    with pytest.raises(TypeError):
        twigg.chat(CHAT, model="m").send("Hi", max_tokenz=5)  # pyright: ignore[reportCallIssue]


# Retries and tools.


@pytest.mark.parametrize("header", ["nan", "inf", "-inf"])
def test_a_non_finite_retry_after_falls_back_to_backoff(header: str) -> None:
    delay = retry_delay(header, 0)
    assert 0 <= delay <= 0.5


async def test_plain_def_tools_run_in_threads_on_the_async_client() -> None:
    @tool
    def slow(n: int) -> str:
        time.sleep(0.3)
        return str(n)

    twigg, api, _ = setup_async()
    api.reply(call_turn([("t1", "slow", '{"n":1}'), ("t2", "slow", '{"n":2}')]), answer_turn("ok"))
    ticks = 0

    async def tick() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.05)
            ticks += 1

    ticker = asyncio.create_task(tick())
    started = time.monotonic()
    await twigg.responses.run_tools(CHAT, **ASK, tools=[slow]).final()
    ticker.cancel()
    assert time.monotonic() - started < 0.55  # side by side, not one after the other
    assert ticks >= 3  # and the event loop kept running meanwhile


async def test_a_throwing_tool_cancels_the_tools_beside_it() -> None:
    effects: list[str] = []

    @tool
    async def boom() -> str:
        raise RuntimeError("boom")

    @tool
    async def slow() -> str:
        await asyncio.sleep(0.2)
        effects.append("slow ran")
        return "x"

    twigg, api, _ = setup_async()
    api.reply(call_turn([("t1", "boom", "{}"), ("t2", "slow", "{}")]))
    with pytest.raises(RuntimeError, match="boom"):
        await twigg.responses.run_tools(
            CHAT, **ASK, tools=[boom, slow], on_tool_error="throw"
        ).final()
    await asyncio.sleep(0.3)
    assert effects == []
