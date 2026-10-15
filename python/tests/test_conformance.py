"""The shared fixtures: every recorded stream must accumulate to its expected result, at any
chunk size and with CRLF line endings, exactly as the TypeScript SDK does."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from twigg import ResponseAccumulator, ResponseResult, ToolCallBlock
from twigg._shared.sse import SseParser

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures/streams"
NAMES = sorted(p.stem for p in FIXTURES.glob("*.sse"))


def to_conformance(result: ResponseResult) -> dict[str, Any]:
    """Map a result into the language-neutral shape in fixtures/README.md."""
    blocks: list[dict[str, Any]] = []
    for block in result.blocks:
        if isinstance(block, ToolCallBlock):
            entry: dict[str, Any] = {
                "type": "tool_call",
                "id": block.call.id,
                "name": block.call.name,
                "input": block.call.input,
                "raw_input": block.call.raw_input,
            }
            if block.call.input_error:
                entry["input_error"] = block.call.input_error
            blocks.append(entry)
        else:
            blocks.append({"type": block.type, "text": block.text})
    return {
        "run_id": result.run_id,
        "chat_id": result.chat_id,
        "text": result.text,
        "reasoning": result.reasoning,
        "refusal": result.refusal,
        "blocks": blocks,
        "pending_tool_call_ids": [c.id for c in result.pending_tool_calls],
        "closed_tool_call_ids": result.closed_tool_calls,
        "stop_reason": result.stop_reason,
        "usage": result.usage.model_dump(),
        "cost": None if result.cost is None else str(result.cost),
        "cost_currency": result.cost_currency,
        "model_served": result.model_served,
        "warnings": [{"source": w.source, **w.data} for w in result.warnings],
    }


def accumulate(text: str, size: int) -> ResponseResult:
    data = text.encode()
    parser = SseParser()
    accumulator = ResponseAccumulator()
    frames = [f for i in range(0, len(data), size) for f in parser.feed(data[i : i + size])]
    for frame in [*frames, *parser.close()]:
        accumulator.push(frame.event, json.loads(frame.data))
    return accumulator.result()


def test_there_are_fixtures() -> None:
    assert NAMES


@pytest.mark.parametrize("name", NAMES)
def test_recorded_stream_accumulates_to_its_expected_result(name: str) -> None:
    sse = (FIXTURES / f"{name}.sse").read_text()
    expected = json.loads((FIXTURES / f"{name}.json").read_text())
    for size in (1, 3, 7, 64, 100_000):
        assert to_conformance(accumulate(sse, size)) == expected
    assert to_conformance(accumulate(sse.replace("\n", "\r\n"), 5)) == expected
