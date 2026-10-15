"""Turning loose input into parts to submit."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel

#: Anything `chat.send` accepts: text, attachments, ready-made parts, or a list of them.
MessageInput = str | Mapping[str, Any] | BaseModel | Sequence["str | Mapping[str, Any] | BaseModel"]


def to_parts(value: MessageInput) -> list[dict[str, Any]]:
    """Consecutive strings and attachments become one prompt, with the strings joined by blank
    lines; ready-made parts (anything with a `type`) pass through in place."""
    items: Sequence[Any] = [value] if isinstance(value, (str, Mapping, BaseModel)) else value
    parts: list[dict[str, Any]] = []
    text: list[str] = []
    media: list[dict[str, Any]] = []

    def flush() -> None:
        if not text and not media:
            return
        prompt: dict[str, Any] = {"type": "prompt"}
        if text:
            prompt["text"] = "\n\n".join(text)
        if media:
            prompt["media"] = list(media)
        parts.append(prompt)
        text.clear()
        media.clear()

    for item in items:
        if isinstance(item, str):
            text.append(item)
            continue
        data: dict[str, Any] = (
            item.model_dump(mode="json", exclude_none=True)
            if isinstance(item, BaseModel)
            else dict(item)
        )
        if "type" in data:
            flush()
            parts.append(data)
        else:
            media.append(data)
    flush()
    return parts
