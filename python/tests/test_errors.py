from __future__ import annotations

import httpx
import pytest

from twigg import (
    AuthenticationError,
    ConflictError,
    IdempotencyConflictError,
    InsufficientBalanceError,
    NotFoundError,
    TwiggError,
    ValidationError,
)
from twigg.errors import error_from_response

from .helpers import json_response, setup


@pytest.mark.parametrize(
    ("status", "code", "cls"),
    [
        (401, "unauthorized", AuthenticationError),
        (402, "payment_required", InsufficientBalanceError),
        (404, "not_found", NotFoundError),
        (409, "conflict", ConflictError),
        (422, "validation_error", ValidationError),
    ],
)
def test_maps_status_to_class(status: int, code: str, cls: type[TwiggError]) -> None:
    twigg, api, _ = setup()
    api.reply(json_response({"error": {"code": code, "message": "nope"}}, status))
    with pytest.raises(cls) as caught:
        twigg.chats.get("chat-1")
    assert (caught.value.status, caught.value.code, caught.value.message) == (status, code, "nope")


def test_keeps_hint_and_details() -> None:
    twigg, api, _ = setup()
    body = {
        "error": {
            "code": "validation_error",
            "message": "bad field",
            "hint": "https://api.twigg.ai/",
            "details": {"field": "namespace"},
        }
    }
    api.reply(json_response(body, 422))
    with pytest.raises(ValidationError) as caught:
        twigg.chats.create()
    assert caught.value.hint == "https://api.twigg.ai/"
    assert caught.value.details == {"field": "namespace"}


def test_falls_back_to_body_text_when_a_proxy_answers() -> None:
    twigg, api, _ = setup(max_retries=0)
    api.reply(httpx.Response(504, text="upstream connect error"))
    with pytest.raises(TwiggError) as caught:
        twigg.models.list()
    assert type(caught.value) is TwiggError
    assert (caught.value.status, caught.value.code) == (504, "http_504")
    assert caught.value.message == "upstream connect error"


def test_reads_the_original_run_from_an_idempotency_conflict() -> None:
    run = "0192f0a0-0000-7000-8000-0000000000aa"
    message = f"idempotency key 'k' was already used; it belongs to run {run}"
    error = error_from_response(409, "", f'{{"error":{{"code":"conflict","message":"{message}"}}}}')
    assert isinstance(error, IdempotencyConflictError)
    assert error.original_run_id == run
    by_details = error_from_response(
        409, "", '{"error":{"code":"conflict","message":"x","details":{"run_id":"r1"}}}'
    )
    assert isinstance(by_details, IdempotencyConflictError)
    assert by_details.original_run_id == "r1"
