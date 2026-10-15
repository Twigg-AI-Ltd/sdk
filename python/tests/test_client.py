from __future__ import annotations

import httpx
import pytest

from twigg import Twigg, TwiggError

from .helpers import FakeApi, json_response, setup


def test_sends_the_api_key_as_a_bearer_token() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({**run_stub()}))
    twigg.runs.get("run-1")
    assert api.last.headers["authorization"] == "Bearer tw_test"
    assert api.last.headers["user-agent"].startswith("twigg-python/")


def test_reads_the_key_and_base_url_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TWIGG_API_KEY", "tw_env")
    monkeypatch.setenv("TWIGG_BASE_URL", "https://env.test")
    api = FakeApi()
    api.reply(json_response([]))
    Twigg(transport=httpx.MockTransport(api.handle)).models.list()
    assert api.last.headers["authorization"] == "Bearer tw_env"
    assert api.last.url.host == "env.test"


def test_fails_before_sending_when_an_authenticated_call_has_no_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TWIGG_API_KEY", raising=False)
    twigg, api, _ = setup(api_key=None)
    with pytest.raises(TwiggError) as caught:
        twigg.chats.create()
    assert caught.value.code == "missing_api_key"
    assert api.requests == []


def test_calls_public_endpoints_without_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TWIGG_API_KEY", raising=False)
    twigg, api, _ = setup(api_key=None)
    api.reply(json_response({"models": [], "markup_percent": "0", "organisation_specific": False}))
    twigg.catalogue.list()
    assert "authorization" not in api.last.headers


def test_keeps_a_path_prefix_on_the_base_url() -> None:
    twigg, api, _ = setup(base_url="https://proxy.test/twigg/")
    api.reply(json_response(run_stub()))
    twigg.runs.get("run-1")
    assert str(api.last.url) == "https://proxy.test/twigg/api/v1/runs/run-1"


def test_percent_encodes_path_parameters() -> None:
    twigg, api, _ = setup()
    api.reply(json_response(summary_stub()))
    twigg.chats.get("a/b?c")
    assert api.last.url.raw_path == b"/api/v1/chats/a%2Fb%3Fc"


def test_merges_client_and_per_call_headers() -> None:
    from twigg import RequestOptions

    twigg, api, _ = setup(headers={"x-team": "billing"})
    api.reply(json_response([]))
    twigg.models.list(options=RequestOptions(headers={"x-trace": "abc"}))
    assert api.last.headers["x-team"] == "billing"
    assert api.last.headers["x-trace"] == "abc"


def test_returns_none_for_an_empty_204() -> None:
    twigg, api, _ = setup()
    api.reply(httpx.Response(204))
    twigg.chats.delete("chat-1")
    assert api.last.method == "DELETE"


def test_returns_markdown_as_text() -> None:
    twigg, api, _ = setup()
    api.reply(httpx.Response(200, text="| model |", headers={"content-type": "text/markdown"}))
    assert twigg.catalogue.markdown() == "| model |"
    assert api.last.headers["accept"] == "text/markdown"


def test_catalogue_names_keep_their_slashes() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({}, 404))
    with pytest.raises(TwiggError):
        twigg.catalogue.get("openrouter/some model")
    assert api.last.url.raw_path == b"/v1/catalogue/openrouter/some%20model"


def run_stub() -> dict[str, object]:
    from .helpers import run_record

    return run_record("succeeded")


def summary_stub() -> dict[str, object]:
    from .helpers import chat_summary

    return chat_summary(1)
