"""Attachments: bytes in, base64 out, with a MIME type and an optional local check against a
model's published limits."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

import httpx

from ._generated.models import CatalogueModel, HistoryPart, HistoryPrompt, HistoryToolResult

_BY_EXTENSION = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "heic": "image/heic",
    "heif": "image/heif",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "html": "text/html",
    "json": "application/json",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "mp4": "video/mp4",
    "webm": "video/webm",
}

#: Where an attachment travels, which decides the limits that apply.
MediaCarrier = Literal["user", "tool_result"]


def from_bytes(data: bytes, mime: str, filename: str | None = None) -> dict[str, Any]:
    """Build an attachment from bytes."""
    return {
        "mime": mime,
        "data_base64": base64.b64encode(data).decode("ascii"),
        "filename": filename,
    }


def from_base64(data: str, mime: str, filename: str | None = None) -> dict[str, Any]:
    """Build an attachment from standard base64, without a data-URI prefix."""
    if data.startswith("data:"):
        raise ValueError("Pass the base64 payload without its data: URI prefix")
    return {"mime": mime, "data_base64": data, "filename": filename}


def from_file(path: str | Path, mime: str | None = None) -> dict[str, Any]:
    """Read a file into an attachment. The MIME type comes from the extension or the file's
    first bytes unless given."""
    file = Path(path)
    data = file.read_bytes()
    resolved = mime or guess_mime(file.name, data)
    if resolved is None:
        raise ValueError(f"Cannot tell the MIME type of {file.name}; pass mime=")
    return from_bytes(data, resolved, file.name)


def from_url(
    url: str, mime: str | None = None, *, client: httpx.Client | None = None
) -> dict[str, Any]:
    """Download a URL into an attachment, taking the MIME type from the response."""
    response = (client or httpx).get(url, follow_redirects=True)
    response.raise_for_status()
    filename = httpx.URL(url).path.rsplit("/", 1)[-1] or None
    header = response.headers.get("content-type", "").split(";")[0].strip() or None
    resolved = mime or header or guess_mime(filename or "", response.content)
    if resolved is None:
        raise ValueError(f"Cannot tell the MIME type of {url}; pass mime=")
    return from_bytes(response.content, resolved, filename)


def guess_mime(filename: str, data: bytes | None = None) -> str | None:
    """The MIME type from a filename's extension, then from well-known leading bytes."""
    if "." in filename:
        found = _BY_EXTENSION.get(filename.rsplit(".", 1)[-1].lower())
        if found:
            return found
    if data is None:
        return None
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    if data.startswith(b"RIFF") and data[8:10] == b"WE":
        return "image/webp"
    return None


def check(
    model: CatalogueModel,
    attachments: list[Mapping[str, Any]],
    carrier: MediaCarrier = "user",
) -> list[str]:
    """Problems Twigg would reject these attachments for on this model, checked locally:
    unsupported types, oversized files and too many attachments. Empty means they fit."""
    policy = model.media.user if carrier == "user" else model.media.tool_result
    problems: list[str] = []
    if len(attachments) > model.media.max_attachments_per_part:
        problems.append(
            f"{model.name} accepts at most {model.media.max_attachments_per_part}"
            " attachments per part"
        )
    limit = policy.max_attachments_per_request
    if limit is not None and len(attachments) > limit:
        problems.append(f"{model.name} accepts at most {limit} {carrier} attachments per request")
    for item in attachments:
        mime = str(item["mime"])
        name = item.get("filename") or mime
        if not any(_mime_matches(pattern, mime) for pattern in policy.mime_types):
            problems.append(f"{model.name} does not accept {mime} ({name}) in {carrier} parts")
        size = _decoded_size(str(item["data_base64"]))
        if size > policy.max_bytes_per_attachment:
            problems.append(
                f"{name} is {size} bytes; {model.name} accepts at most "
                f"{policy.max_bytes_per_attachment}"
            )
    return problems


def to_submittable(part: HistoryPart) -> dict[str, Any]:
    """A stored prompt or tool result as a part to submit again. Attachments come along only
    when the history was read with `include="full"`. Assistant-authored parts cannot be
    submitted."""
    media = [
        {"mime": m.mime, "data_base64": m.data_base64, "filename": m.filename}
        for m in part.media or []
        if m.data_base64
    ]
    body = part.part
    extra: dict[str, Any] = {"media": media} if media else {}
    if isinstance(body, HistoryPrompt):
        return {"type": "prompt", "text": body.text, **extra}
    if isinstance(body, HistoryToolResult):
        return {
            "type": "tool_result",
            "tool_use_id": body.tool_use_id,
            "tool_name": body.tool_name,
            "text": body.text,
            "is_error": body.is_error,
            "trust": body.trust,
            **extra,
        }
    raise ValueError(f"A {body.type} part was written by the model and cannot be submitted")


def _mime_matches(pattern: str, mime: str) -> bool:
    if pattern in (mime, "*/*"):
        return True
    return pattern.endswith("/*") and mime.startswith(pattern[:-1])


def _decoded_size(data: str) -> int:
    padding = 2 if data.endswith("==") else 1 if data.endswith("=") else 0
    return len(data) * 3 // 4 - padding
