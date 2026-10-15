# Generated from src/twigg/_async/transport.py by scripts/unasync.py. Do not edit.
"""The one place requests are sent: auth, per-attempt timeouts, retries, and turning error
responses into TwiggError subclasses. Resources describe requests; they never send them."""

from __future__ import annotations

import json
from typing import Any

import httpx

from .._shared.request import (
    ApiRequest,
    ClientConfig,
    RequestOptions,
    build_headers,
    build_url,
    retry_delay,
    should_retry,
)
from ..errors import (
    APIConnectionError,
    APITimeoutError,
    TwiggError,
    error_from_response,
    invalid_response,
)
from ._support import HttpClient, SleepFn

Failure = tuple[TwiggError, "str | None"]


class Transport:
    def __init__(self, config: ClientConfig, http: HttpClient, sleep: SleepFn) -> None:
        self.config = config
        self.http = http
        self.sleep = sleep

    def json(self, request: ApiRequest, options: RequestOptions | None = None) -> Any:
        """Send a request and parse its JSON body; `None` for an empty body."""
        text = self.text(request, options)
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError as error:
            raise invalid_response(f"{request.method} {request.path} is not JSON", error) from error

    def text(self, request: ApiRequest, options: RequestOptions | None = None) -> str:
        """Send a request and return its body as text. Retries and error mapping apply."""
        max_retries = self.max_retries(options)
        attempt = 0
        while True:
            outcome = self._attempt(request, options)
            if isinstance(outcome, str):
                return outcome
            error, retry_after = outcome
            if not should_retry(request, error, attempt, max_retries):
                raise error
            self.delay(retry_after, attempt)
            attempt += 1

    def open(
        self, request: ApiRequest, options: RequestOptions | None, idle_timeout: float
    ) -> httpx.Response | Failure:
        """Open a streaming response: one attempt, no retries. The read timeout is the idle
        timeout, so a silent connection counts as dropped. Error statuses become TwiggErrors."""
        timeout = self.timeout(options)
        built = self.http.build_request(
            request.method,
            build_url(self.config, request),
            headers=build_headers(self.config, request, options),
            content=None if request.body is None else json.dumps(request.body),
            timeout=httpx.Timeout(timeout, read=idle_timeout),
        )
        try:
            response = self.http.send(built, stream=True)
        except httpx.TimeoutException as cause:
            return _timeout(timeout, cause), None
        except httpx.TransportError as cause:
            return _connection(cause), None
        if response.is_success:
            return response
        try:
            response.read()
        finally:
            response.close()
        return (
            error_from_response(response.status_code, response.reason_phrase, response.text),
            response.headers.get("retry-after"),
        )

    def delay(self, retry_after: str | None, attempt: int) -> None:
        """The wait before retry number `attempt + 1`, honouring Retry-After."""
        self.sleep(retry_delay(retry_after, attempt))

    def max_retries(self, options: RequestOptions | None) -> int:
        if options and options.max_retries is not None:
            return options.max_retries
        return self.config.max_retries

    def timeout(self, options: RequestOptions | None) -> float:
        if options and options.timeout is not None:
            return options.timeout
        return self.config.timeout

    def _attempt(self, request: ApiRequest, options: RequestOptions | None) -> str | Failure:
        headers = build_headers(self.config, request, options)
        timeout = self.timeout(options)
        try:
            response = self.http.request(
                request.method,
                build_url(self.config, request),
                headers=headers,
                content=None if request.body is None else json.dumps(request.body),
                timeout=timeout,
            )
        except httpx.TimeoutException as cause:
            return _timeout(timeout, cause), None
        except httpx.TransportError as cause:
            return _connection(cause), None
        if response.is_success:
            return response.text
        return (
            error_from_response(response.status_code, response.reason_phrase, response.text),
            response.headers.get("retry-after"),
        )


def _timeout(seconds: float, cause: Exception) -> TwiggError:
    error = APITimeoutError(f"No response within {seconds}s", code="timeout")
    error.__cause__ = cause
    return error


def _connection(cause: Exception) -> TwiggError:
    error = APIConnectionError(str(cause) or type(cause).__name__, code="connection_error")
    error.__cause__ = cause
    return error
