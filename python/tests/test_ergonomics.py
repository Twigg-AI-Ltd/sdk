from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import pytest

from twigg import media, to_parts
from twigg._generated.models import MediaCapabilities
from twigg.types import CatalogueModel, HistoryPart

from .helpers import CHAT, RUN, json_response, setup, sse_response, text_turn

PNG = {"mime": "image/png", "data_base64": "iVBORw0KGgo=", "filename": "a.png"}


def test_joins_strings_and_attachments_into_one_prompt() -> None:
    result = {"type": "tool_result", "tool_use_id": "t1", "tool_name": "x", "text": "r"}
    assert to_parts(["Look", PNG, "closely", result, "then this"]) == [
        {"type": "prompt", "text": "Look\n\nclosely", "media": [PNG]},
        result,
        {"type": "prompt", "text": "then this"},
    ]


def test_opens_a_chat_and_sends_with_its_defaults() -> None:
    twigg, api, _ = setup()
    created: dict[str, Any] = {
        "id": CHAT,
        "namespace": "acme",
        "title": None,
        "description": None,
        "user_metadata": {},
        "created_at": "2026-10-14T00:00:00Z",
    }
    api.reply(json_response(created, 201), sse_response(text_turn("Hi!")))
    chat = twigg.chats.open(namespace="acme", defaults={"model": "claude-opus-5"})
    assert chat.id == CHAT
    assert chat.data is not None and chat.data.namespace == "acme"
    reply = chat.send("Hello", max_tokens=100)
    assert reply.text == "Hi!"
    assert api.body() == {
        "model": "claude-opus-5",
        "max_tokens": 100,
        "input": [{"type": "prompt", "text": "Hello"}],
        "idempotency_key": api.body()["idempotency_key"],
    }


def test_stream_options_stay_out_of_the_body() -> None:
    twigg, api, _ = setup()
    api.reply(sse_response(text_turn()))
    twigg.chat(CHAT, model="m").send("Hi", recover=False, idle_timeout=5.0)
    assert "recover" not in api.body()
    assert "idle_timeout" not in api.body()


def test_a_scope_pins_every_call_to_its_namespace() -> None:
    twigg, api, _ = setup()
    scope = twigg.namespace("acme").child("support")
    created: dict[str, Any] = {
        "id": CHAT,
        "namespace": "acme/support",
        "title": "x",
        "description": None,
        "user_metadata": {},
        "created_at": "2026-10-14T00:00:00Z",
    }
    api.reply(json_response(created))
    scope.chats.create(title="x")
    assert api.body() == {"title": "x", "namespace": "acme/support"}
    version = {
        "id": "v1",
        "version": 1,
        "estimated_tokens": 3,
        "is_active": True,
        "created_at": "2026-10-14T00:00:00Z",
    }
    api.reply(json_response(version))
    scope.config.instructions.publish(body="Be kind.", mode="replace")
    assert api.body()["namespace"] == "acme/support"
    api.reply(json_response([]))
    scope.config.budgets.versions(model=RUN)
    assert api.last.url.params["namespace"] == "acme/support"
    assert api.last.url.params["model"] == RUN


def test_a_scope_takes_no_namespace_of_its_own() -> None:
    twigg, _, _ = setup()
    with pytest.raises(TypeError):
        twigg.namespace("acme").chats.create(namespace="other")  # pyright: ignore[reportCallIssue]


def test_encodes_bytes_and_files(tmp_path: Path) -> None:
    assert media.from_bytes(b"hi", "text/plain", "hi.txt") == {
        "mime": "text/plain",
        "data_base64": "aGk=",
        "filename": "hi.txt",
    }
    file = tmp_path / "report"
    file.write_bytes(b"%PDF-1.7")
    attachment = media.from_file(file)
    assert attachment["mime"] == "application/pdf"
    assert base64.b64decode(attachment["data_base64"]) == b"%PDF-1.7"


def test_guesses_mime_types() -> None:
    assert media.guess_mime("chart.PNG") == "image/png"
    assert media.guess_mime("blob", b"%PDF") == "application/pdf"
    assert media.guess_mime("blob", b"\x01\x02") is None


def test_rejects_a_data_uri() -> None:
    with pytest.raises(ValueError, match="prefix"):
        media.from_base64("data:image/png;base64,AAAA", "image/png")


def test_checks_attachments_against_a_models_limits() -> None:
    capabilities = MediaCapabilities.model_validate(
        {
            "configured": True,
            "max_attachments_per_part": 1,
            "user": {"mime_types": ["image/*"], "max_bytes_per_attachment": 4},
            "tool_result": {"mime_types": [], "max_bytes_per_attachment": 0},
            "assistant": {"mime_types": [], "max_bytes_per_attachment": 0},
        }
    )
    model = CatalogueModel.model_construct(name="m", media=capabilities)
    assert media.check(model, [{"mime": "image/png", "data_base64": "AAAA"}]) == []
    problems = media.check(
        model,
        [
            {"mime": "application/pdf", "data_base64": "AAAAAAAA", "filename": "r.pdf"},
            {"mime": "image/png", "data_base64": "AAAA"},
        ],
    )
    assert len(problems) == 3


def test_turns_stored_prompts_back_into_parts() -> None:
    stored: dict[str, Any] = {
        "id": "0192f0a0-0000-7000-8000-000000000001",
        "ordinal": 1,
        "role": "user",
        "created_at": "2026-10-14T00:00:00Z",
        "user_metadata": {},
        "part": {"type": "prompt", "text": "again"},
        "media": [
            {
                "media_id": "0192f0a0-0000-7000-8000-000000000002",
                "mime": "image/png",
                "byte_len": 3,
                "data_base64": "AAAA",
                "filename": "a.png",
            }
        ],
    }
    assert media.to_submittable(HistoryPart.model_validate(stored)) == {
        "type": "prompt",
        "text": "again",
        "media": [{"mime": "image/png", "data_base64": "AAAA", "filename": "a.png"}],
    }
    stored["role"] = "assistant"
    stored["part"] = {"type": "message", "text": "hi"}
    with pytest.raises(ValueError, match="written by the model"):
        media.to_submittable(HistoryPart.model_validate(stored))


def _summary() -> dict[str, Any]:
    return {
        "id": CHAT,
        "namespace": "me",
        "title": "Plans",
        "description": None,
        "user_metadata": {},
        "length": 2,
        "created_at": "2026-10-14T00:00:00Z",
        "updated_at": "2026-10-14T00:01:00Z",
    }


def test_turns_a_listed_summary_into_a_chat_using_the_client_model() -> None:
    twigg, api, _ = setup(model="gpt-6-luna")
    page = {"data": [_summary()], "first_id": CHAT, "last_id": CHAT, "has_more": False}
    api.reply(json_response(page), sse_response(text_turn("hi")))
    summary = twigg.chats.list(namespace="me").data[0]
    chat = twigg.chat(summary)
    assert chat.id == CHAT
    assert chat.data is summary
    assert chat.send("hello").text == "hi"
    assert api.body()["model"] == "gpt-6-luna"


def test_chat_defaults_and_calls_override_the_client_model() -> None:
    twigg, api, _ = setup(model="client-model")
    api.reply(sse_response(text_turn()), sse_response(text_turn()))
    chat = twigg.chat(CHAT, model="chat-model")
    chat.send("a")
    assert api.body()["model"] == "chat-model"
    chat.send("b", model="call-model")
    assert api.body()["model"] == "call-model"


def test_explains_a_turn_with_no_model_anywhere() -> None:
    from twigg import TwiggError

    twigg, api, _ = setup()
    with pytest.raises(TwiggError, match="No model"):
        twigg.chat(CHAT).stream("hi")
    assert api.requests == []
