"""Request descriptions and the retry policy, shared by the sync and async transports."""

from __future__ import annotations

import math
import os
import random
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Literal
from urllib.parse import quote, urlencode

from pydantic import BaseModel

from .._version import __version__
from ..errors import APIConnectionError, TwiggError

DEFAULT_BASE_URL = "https://api.twigg.ai"
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
BASE_DELAY = 0.5
MAX_DELAY = 30.0


@dataclass(frozen=True)
class RequestOptions:
    """Per-call overrides, accepted as `options=` by every SDK method."""

    #: Seconds per attempt, overriding the client's `timeout`.
    timeout: float | None = None
    #: Overrides the client's `max_retries` for this call.
    max_retries: int | None = None
    #: Extra headers for this call.
    headers: Mapping[str, str] = field(default_factory=lambda: dict[str, str]())


@dataclass(frozen=True)
class ApiRequest:
    method: Literal["GET", "POST", "PUT", "DELETE"]
    path: str
    query: Mapping[str, Any] | None = None
    body: Any = None
    #: `required` fails before sending when there is no API key. `optional` sends the key when
    #: there is one: the public catalogue then prices for the caller's organisation.
    auth: Literal["required", "optional"] = "required"
    #: Whether repeating the request is harmless. Idempotent requests retry on network errors,
    #: timeouts and 5xx; others retry only on 429, which the API returns before doing anything.
    idempotent: bool = True
    accept: str = "application/json"


@dataclass(frozen=True)
class ClientConfig:
    api_key: str | None = field(repr=False)
    base_url: str
    timeout: float
    max_retries: int
    headers: Mapping[str, str]


def resolve_config(
    api_key: str | None,
    base_url: str | None,
    timeout: float,
    max_retries: int,
    headers: Mapping[str, str] | None,
) -> ClientConfig:
    """Fill in defaults from `TWIGG_API_KEY` and `TWIGG_BASE_URL`."""
    return ClientConfig(
        api_key=api_key or os.environ.get("TWIGG_API_KEY") or None,
        base_url=base_url or os.environ.get("TWIGG_BASE_URL") or DEFAULT_BASE_URL,
        timeout=timeout,
        max_retries=max_retries,
        headers=dict(headers or {}),
    )


def build_url(config: ClientConfig, request: ApiRequest) -> str:
    # Concatenated rather than resolved, so a base URL with a path prefix keeps it.
    url = config.base_url.rstrip("/") + request.path
    query = {k: _query_value(v) for k, v in (request.query or {}).items() if v is not None}
    return f"{url}?{urlencode(query)}" if query else url


def build_headers(
    config: ClientConfig, request: ApiRequest, options: RequestOptions | None
) -> dict[str, str]:
    headers = {
        "Accept": request.accept,
        "User-Agent": f"twigg-python/{__version__}",
        **config.headers,
        **(options.headers if options else {}),
    }
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    elif request.auth == "required":
        raise TwiggError(
            "No API key. Pass api_key to Twigg() or set TWIGG_API_KEY.", code="missing_api_key"
        )
    if request.body is not None:
        headers["Content-Type"] = "application/json"
    return headers


def should_retry(request: ApiRequest, error: TwiggError, attempt: int, max_retries: int) -> bool:
    """Whether a failed attempt may be repeated. 429 always: the API rejects before doing
    anything. Network errors, timeouts and 5xx only when repeating the request is harmless."""
    if attempt >= max_retries:
        return False
    if error.status == 429:
        return True
    return request.idempotent and (
        isinstance(error, APIConnectionError) or (error.status or 0) in RETRYABLE_STATUS
    )


def retry_delay(retry_after: str | None, attempt: int) -> float:
    """Seconds to wait: Retry-After when present, otherwise exponential backoff with jitter."""
    if retry_after:
        try:
            seconds = float(retry_after)
            if math.isfinite(seconds):
                return _clamp(seconds)
        except ValueError:
            try:
                return _clamp(parsedate_to_datetime(retry_after).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
    ceiling = min(BASE_DELAY * 2**attempt, MAX_DELAY)
    return ceiling / 2 + random.random() * ceiling / 2


def segment(value: object) -> str:
    """Percent-encode one path parameter. Empty, `.` and `..` are refused: URL resolution would
    turn them into a different path, sending the API key to an endpoint the caller never named."""
    text = str(value)
    if text in ("", ".", ".."):
        raise ValueError(f"Invalid path segment: {text!r}")
    return quote(text, safe="")


def compact(**fields: Any) -> dict[str, Any]:
    """Drop `None` fields and serialise pydantic models, for request bodies and queries."""
    return {k: dump(v) for k, v in fields.items() if v is not None}


def dump(value: Any) -> Any:
    """Turn pydantic models (at any depth) into JSON-ready values."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, Mapping):
        return {str(k): dump(v) for k, v in value.items()}  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
    if isinstance(value, (list, tuple)):
        return [dump(v) for v in value]  # pyright: ignore[reportUnknownVariableType]
    to_definition = getattr(value, "definition", None)
    if isinstance(to_definition, dict):
        return to_definition  # pyright: ignore[reportUnknownVariableType]
    return value


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _clamp(seconds: float) -> float:
    return min(max(seconds, 0.0), MAX_DELAY)
