"""The async client: the same source as the sync one, so these cover what differs."""

from __future__ import annotations

import asyncio
from typing import Any

from twigg import AsyncTwigg, DeltaEvent, tool

from .helpers import (
    CHAT,
    RUN_EVENT,
    answer_turn,
    api_error,
    call_turn,
    history_page,
    json_response,
    part,
    run_record,
    setup_async,
    sse_response,
    sse_text,
    text_turn,
)

ASK: dict[str, Any] = {"model": "claude-opus-5", "input": [{"type": "prompt", "text": "go"}]}


async def test_retries_and_parses() -> None:
    twigg, api, sleeps = setup_async()
    api.reply(api_error(503, "unavailable"), json_response([]))
    assert await twigg.models.list() == []
    assert len(sleeps) == 1


async def test_pages_with_async_for() -> None:
    twigg, api, _ = setup_async()

    def prompt(n: int) -> dict[str, Any]:
        return part(n, "user", {"type": "prompt", "text": str(n)})

    api.reply(
        json_response(history_page([prompt(3), prompt(4)], True)),
        json_response(history_page([prompt(1), prompt(2)], False)),
    )
    page = await twigg.chats.history(CHAT)
    assert [p.ordinal async for p in page] == [4, 3, 2, 1]


async def test_streams_and_finalises() -> None:
    twigg, api, _ = setup_async()
    api.reply(sse_response(text_turn("Hi there")))
    async with twigg.responses.stream(CHAT, **ASK) as stream:
        texts = [e.text async for e in stream if isinstance(e, DeltaEvent)]
        assert await stream.run_id
        result = await stream.final()
    assert texts == ["Hi there"]
    assert result.text == "Hi there"


async def test_recovers_after_a_drop() -> None:
    twigg, api, _ = setup_async()
    api.reply(
        sse_response(sse_text([RUN_EVENT]), drop=True),
        json_response(run_record("succeeded")),
        json_response(history_page([part(2, "assistant", {"type": "message", "text": "Hallo"})])),
    )
    result = await twigg.responses.stream(CHAT, **ASK).final()
    assert (result.recovered, result.text) == (True, "Hallo")


async def test_runs_async_tools_concurrently() -> None:
    running = 0
    peak = 0

    @tool
    async def slow(n: int) -> str:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return str(n * 2)

    twigg, api, _ = setup_async()
    api.reply(
        call_turn([(f"t{i}", "slow", f'{{"n":{i}}}') for i in range(4)]),
        answer_turn("done"),
    )
    outcome = await twigg.responses.run_tools(CHAT, **ASK, tools=[slow], tool_concurrency=2).final()
    assert outcome.stop_reason == "end_turn"
    assert peak == 2
    assert [p["text"] for p in api.body(1)["input"]] == ["0", "2", "4", "6"]


async def test_chat_handles_and_scopes() -> None:
    twigg, api, _ = setup_async()
    api.reply(sse_response(text_turn("Yes")))
    reply = await twigg.chat(CHAT, model="m").send("Hi")
    assert reply.text == "Yes"
    api.reply(json_response({"data": [], "first_id": None, "last_id": None, "has_more": False}))
    await twigg.namespace("acme").chats.list()
    assert api.last.url.params["namespace"] == "acme"


async def test_closes_its_http_client() -> None:
    twigg = AsyncTwigg(api_key="x")
    async with twigg:
        pass
    assert twigg._http.is_closed
