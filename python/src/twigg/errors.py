"""One error family for every failure: HTTP errors, network failures and stream errors all carry
the API's own `code`, `message`, `hint` and `details`."""

from __future__ import annotations

import json
import re
from typing import Any


class TwiggError(Exception):
    """Base class for every SDK error. A response the SDK cannot read (not JSON, or not the
    shape the API documents) raises one with `code="invalid_response"`."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int | None = None,
        hint: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        #: The API's machine-readable code, such as `validation_error` or `not_found`.
        self.code = code
        #: HTTP status, when the API answered. `None` for network failures.
        self.status = status
        self.hint = hint
        self.details = details


class BadRequestError(TwiggError):
    """400: the request was malformed."""


class AuthenticationError(TwiggError):
    """401: missing or invalid API key."""


class InsufficientBalanceError(TwiggError):
    """402: the balance cannot pay for this request."""


class PermissionDeniedError(TwiggError):
    """403: the key is valid but not allowed to do this."""


class NotFoundError(TwiggError):
    """404: no such resource in this organisation."""


class ConflictError(TwiggError):
    """409: the chat is busy, the idempotency key was used, or there is nothing to abort."""


class IdempotencyConflictError(ConflictError):
    """409: this idempotency key already started a run. The API does not replay that run's
    stream; `responses.stream` recovers its result instead, unless recovery is off."""

    def __init__(self, message: str, *, original_run_id: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        #: The run the key already belongs to.
        self.original_run_id = original_run_id


class PayloadTooLargeError(TwiggError):
    """413: the request body is over the size limit."""


class ValidationError(TwiggError):
    """422: the request parsed but failed validation. `details` may say which field."""


class RateLimitError(TwiggError):
    """429: too many requests. Retried automatically."""


class InternalServerError(TwiggError):
    """500: an unexpected failure inside Twigg."""


class UpstreamError(TwiggError):
    """502: a model provider or other upstream failed."""


class ServiceUnavailableError(TwiggError):
    """503: Twigg is temporarily unavailable."""


class StreamError(TwiggError):
    """The stream reported a failure after it opened, or the run it was recovering failed."""

    def __init__(self, message: str, *, run_id: str | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        #: The run that failed, when the stream got far enough to name it.
        self.run_id = run_id


class APIConnectionError(TwiggError):
    """No response: DNS, TCP, TLS or a dropped connection."""


class APITimeoutError(APIConnectionError, TimeoutError):
    """No response within the configured timeout. Also a built-in `TimeoutError`."""


def invalid_response(what: str, cause: Exception) -> TwiggError:
    """A response the SDK could not read: not JSON, or not the documented shape."""
    return TwiggError(
        f"Unexpected response from the API ({what}): {cause}",
        code="invalid_response",
        details=str(cause),
    )


_BY_STATUS: dict[int, type[TwiggError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    402: InsufficientBalanceError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    413: PayloadTooLargeError,
    422: ValidationError,
    429: RateLimitError,
    500: InternalServerError,
    502: UpstreamError,
    503: ServiceUnavailableError,
}

_IDEMPOTENT_RUN = re.compile(r"idempotency key .* belongs to run ([0-9a-f-]{36})", re.IGNORECASE)


def error_from_response(status: int, reason: str, text: str) -> TwiggError:
    """Build the right error class from an HTTP status and the response body text."""
    body = _parse_error_body(text)
    cls = _BY_STATUS.get(status, TwiggError)
    if body is None:
        message = text.strip() or reason or f"HTTP {status}"
        return cls(message, code=f"http_{status}", status=status)
    fields: dict[str, Any] = {
        "code": body["code"],
        "status": status,
        "hint": body.get("hint"),
        "details": body.get("details"),
    }
    if status == 409:
        original = _idempotent_run(body)
        if original:
            return IdempotencyConflictError(body["message"], original_run_id=original, **fields)
    return cls(body["message"], **fields)


def _idempotent_run(body: dict[str, Any]) -> str | None:
    """The run a replayed idempotency key belongs to: `details.run_id` when the API sends it,
    otherwise parsed from the message."""
    details = body.get("details")
    if isinstance(details, dict):
        run_id = details.get("run_id")  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        if isinstance(run_id, str):
            return run_id
    match = _IDEMPOTENT_RUN.search(str(body["message"]))
    return match.group(1) if match else None


def _parse_error_body(text: str) -> dict[str, Any] | None:
    try:
        envelope = json.loads(text)
    except ValueError:
        # Not the JSON envelope; a proxy or load balancer answered.
        return None
    error = envelope.get("error") if isinstance(envelope, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    if (
        isinstance(error, dict)
        and isinstance(error.get("code"), str)  # pyright: ignore[reportUnknownMemberType]
        and isinstance(error.get("message"), str)  # pyright: ignore[reportUnknownMemberType]
    ):
        return error  # pyright: ignore[reportUnknownVariableType]
    return None
