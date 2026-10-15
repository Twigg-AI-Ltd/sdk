"""Server-sent events parsing (https://html.spec.whatwg.org/multipage/server-sent-events.html).
Incremental, so the sync and async readers share it, and robust to arbitrary chunk boundaries,
including a \\r\\n split in two."""

from __future__ import annotations

import codecs
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SseFrame:
    event: str
    data: str


class SseParser:
    """Feed decoded bytes in; complete frames come out."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._event = ""
        self._data: list[str] = []

    def feed(self, chunk: bytes) -> list[SseFrame]:
        self._buffer += self._decoder.decode(chunk)
        return self._flush(final=False)

    def close(self) -> list[SseFrame]:
        """Flush what is left. Lenient: dispatches a final frame without a blank line."""
        self._buffer += self._decoder.decode(b"", final=True)
        frames = self._flush(final=True)
        if self._buffer:
            frame = self._line(self._buffer)
            self._buffer = ""
            if frame:
                frames.append(frame)
        last = self._line("")
        if last:
            frames.append(last)
        return frames

    def _flush(self, final: bool) -> list[SseFrame]:
        frames: list[SseFrame] = []
        buffer = self._buffer
        start = 0
        while start < len(buffer):
            cr = buffer.find("\r", start)
            lf = buffer.find("\n", start)
            if cr == -1 and lf == -1:
                break
            end = lf if cr == -1 else cr if lf == -1 else min(cr, lf)
            following = end + 1
            if buffer[end] == "\r":
                # A trailing \r may be the first half of \r\n split across chunks.
                if end == len(buffer) - 1 and not final:
                    break
                if following < len(buffer) and buffer[following] == "\n":
                    following += 1
            frame = self._line(buffer[start:end])
            if frame:
                frames.append(frame)
            start = following
        self._buffer = buffer[start:]
        return frames

    def _line(self, line: str) -> SseFrame | None:
        if line == "":
            if not self._data:
                self._event = ""
                return None
            frame = SseFrame(self._event or "message", "\n".join(self._data))
            self._event = ""
            self._data = []
            return frame
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        return None


def format_sse(event: str, data: Any) -> bytes:
    """Serialise one event as an SSE frame."""
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()
