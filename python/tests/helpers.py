"""A fake API for both clients: records every request and answers from a queue."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx

from twigg import AsyncTwigg, Twigg

RUN = "0192f0a0-0000-7000-8000-0000000000aa"
CHAT = "0192f0a0-0000-7000-8000-0000000000cc"

Reply = httpx.Response | Exception | Callable[[httpx.Request], httpx.Response]


class Chunks(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A body sent in chunks that can fail after the last one, as a dropped connection does."""

    def __init__(self, chunks: list[bytes], error: Exception | None = None) -> None:
        self.chunks = chunks
        self.error = error

    def __iter__(self) -> Iterator[bytes]:
        yield from self.chunks
        if self.error is not None:
            raise self.error

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield chunk
        if self.error is not None:
            raise self.error


class FakeApi:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.replies: list[Reply] = []

    def reply(self, *replies: Reply) -> None:
        self.replies.extend(replies)

    def handle(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        reply = self.replies.pop(0) if self.replies else json_response({})
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            return reply(request)
        return reply

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self, index: int = -1) -> Any:
        return json.loads(self.requests[index].content)

    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]


def json_response(
    body: Any, status: int = 200, headers: dict[str, str] | None = None
) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def api_error(status: int, code: str, message: str | None = None) -> httpx.Response:
    return json_response({"error": {"code": code, "message": message or code}}, status)


def setup(**options: Any) -> tuple[Twigg, FakeApi, list[float]]:
    api = FakeApi()
    sleeps: list[float] = []
    settings: dict[str, Any] = {
        "api_key": "tw_test",
        "base_url": "https://api.test",
        "transport": httpx.MockTransport(api.handle),
        "_sleep": sleeps.append,
        **options,
    }
    return Twigg(**settings), api, sleeps


def setup_async(**options: Any) -> tuple[AsyncTwigg, FakeApi, list[float]]:
    api = FakeApi()
    sleeps: list[float] = []

    async def record(seconds: float) -> None:
        sleeps.append(seconds)

    settings: dict[str, Any] = {
        "api_key": "tw_test",
        "base_url": "https://api.test",
        "transport": httpx.MockTransport(api.handle),
        "_sleep": record,
        **options,
    }
    return AsyncTwigg(**settings), api, sleeps


def sse_text(events: list[tuple[str, Any]]) -> str:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)


def sse_response(
    text: str, *, drop: bool = False, error: Exception | None = None
) -> httpx.Response:
    failure = error or (httpx.ReadError("terminated") if drop else None)
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        stream=Chunks([text.encode()], failure),
    )


RUN_EVENT: tuple[str, Any] = ("run", {"run_id": RUN, "chat_id": CHAT, "closed_tool_calls": []})


def done_event(**overrides: Any) -> tuple[str, Any]:
    data: dict[str, Any] = {
        "compaction": None,
        "cost": "0.0010",
        "cost_currency": "USD",
        "model_served": "claude-opus-5",
        "pending_tool_calls": [],
        "provider_response_id": "msg_1",
        "server_tools": None,
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
        },
        **overrides,
    }
    return ("done", data)


def text_turn(text: str = "Hello") -> str:
    return sse_text(
        [
            RUN_EVENT,
            ("config_warnings", {"warnings": []}),
            ("block_start", {"kind": "text"}),
            ("delta", {"kind": "text", "text": text}),
            ("block_stop", {}),
            done_event(),
        ]
    )


def call_turn(calls: list[tuple[str, str, str]]) -> httpx.Response:
    """A turn that calls tools: (id, name, raw arguments) each."""
    events: list[tuple[str, Any]] = [RUN_EVENT]
    for call_id, name, args in calls:
        events += [
            ("block_start", {"kind": "tool_call", "tool_use_id": call_id, "tool_name": name}),
            ("delta", {"kind": "tool_input", "text": args}),
            ("block_stop", {}),
        ]
    pending = [{"tool_use_id": c, "tool_name": n} for c, n, _ in calls]
    events.append(done_event(stop_reason="tool_use", pending_tool_calls=pending))
    return sse_response(sse_text(events))


def answer_turn(text: str) -> httpx.Response:
    return sse_response(
        sse_text(
            [
                RUN_EVENT,
                ("block_start", {"kind": "text"}),
                ("delta", {"kind": "text", "text": text}),
                done_event(),
            ]
        )
    )


def run_record(status: str, **extra: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": RUN,
        "chat_id": CHAT,
        "namespace": None,
        "origin": "customer",
        "status": status,
        "is_live": False,
        "error": None,
        "model": "claude-opus-5",
        "provider_request_id": None,
        "usage": None,
        "latency_ms": None,
        "cost": None,
        "settled_at": None,
        "manifest": {},
        "created_at": "2026-10-14T10:00:00Z",
        "completed_at": None,
    }
    record.update(extra)
    return record


def part(
    ordinal: int, role: str, body: dict[str, Any], at: str = "2026-10-14T10:00:01Z"
) -> dict[str, Any]:
    return {
        "id": f"0192f0a0-0000-7000-8000-{ordinal:012d}",
        "ordinal": ordinal,
        "role": role,
        "created_at": at,
        "user_metadata": {},
        "part": body,
    }


def history_page(parts: list[dict[str, Any]], has_more: bool = False) -> dict[str, Any]:
    return {
        "data": parts,
        "first_ordinal": parts[0]["ordinal"] if parts else None,
        "last_ordinal": parts[-1]["ordinal"] if parts else None,
        "has_more": has_more,
    }


def chat_summary(index: int) -> dict[str, Any]:
    return {
        "id": f"0192f0a0-0000-7000-8000-{index:012d}",
        "created_at": "2026-10-14T00:00:00Z",
        "namespace": None,
        "title": None,
        "description": None,
        "length": 0,
        "user_metadata": {},
        "updated_at": "2026-10-14T00:00:00Z",
    }
