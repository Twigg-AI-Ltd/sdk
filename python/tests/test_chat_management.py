"""Updating chats, listing their runs, deleting by namespace prefix, usage and client_data."""

from __future__ import annotations

from typing import Any

import pytest

from .helpers import (
    CHAT,
    api_error,
    chat_summary,
    history_page,
    json_response,
    run_record,
    setup,
    sse_response,
    text_turn,
)


def rid(n: int) -> str:
    return f"0192f0a0-0000-7000-8000-{n:012d}"


def run_summary(run_id: str) -> dict[str, Any]:
    record = run_record("succeeded", id=run_id)
    for key in ("chat_id", "namespace", "manifest"):
        del record[key]
    return record


def runs_page(ids: list[str], has_more: bool) -> dict[str, Any]:
    return {
        "data": [run_summary(i) for i in ids],
        "first_id": ids[0],
        "last_id": ids[-1],
        "has_more": has_more,
    }


def test_update_sends_only_the_fields_given_with_none_as_null() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({**chat_summary(1), "title": "Renamed"}))
    chat = twigg.chats.update(
        CHAT, title="Renamed", description=None, user_metadata={"tier": "gold", "stale": None}
    )
    assert chat.title == "Renamed"
    assert api.last.method == "PATCH"
    assert api.last.url.path == f"/api/v1/chats/{CHAT}"
    assert api.body() == {
        "title": "Renamed",
        "description": None,
        "user_metadata": {"tier": "gold", "stale": None},
    }
    api.reply(json_response(chat_summary(1)))
    twigg.chats.update(CHAT, title="Only this")
    assert api.body() == {"title": "Only this"}


def test_update_is_retried_like_other_idempotent_calls() -> None:
    twigg, api, _ = setup()
    api.reply(api_error(503, "unavailable"), json_response(chat_summary(1)))
    twigg.chats.update(CHAT, title="x")
    assert [r.method for r in api.requests] == ["PATCH", "PATCH"]


def test_update_works_from_both_kinds_of_chat_handle() -> None:
    twigg, api, _ = setup()
    api.reply(*(json_response(chat_summary(1)) for _ in range(3)))
    twigg.chat(CHAT).update(title="a")
    assert api.last.url.path == f"/api/v1/chats/{CHAT}"
    twigg.chat_by_external_id("+447700").update(title="b")
    assert api.last.url.raw_path == b"/api/v1/chats/external/%2B447700"
    twigg.chats.update_by_external_id("wa:1", title="c")
    assert api.last.url.raw_path == b"/api/v1/chats/external/wa%3A1"


def test_usage_is_asked_for_with_include_and_not_otherwise() -> None:
    twigg, api, _ = setup()
    usage = {
        "cost": "0.03",
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "runs": 2,
        "unsettled_runs": 0,
    }
    api.reply(json_response(chat_summary(1)), json_response({**chat_summary(1), "usage": usage}))
    assert twigg.chats.get(CHAT).usage is None
    assert api.last.url.query == b""
    chat = twigg.chats.get(CHAT, include="usage")
    assert api.last.url.params["include"] == "usage"
    assert chat.usage is not None and chat.usage.cost == "0.03"
    api.reply(json_response(chat_summary(1)), json_response(chat_summary(1)))
    twigg.chat(CHAT).get(include="usage")
    assert api.last.url.params["include"] == "usage"
    twigg.chats.get_by_external_id("wa:1", include="usage")
    assert api.last.url.params["include"] == "usage"


def test_runs_iterate_older_with_after_id() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response(runs_page([rid(4), rid(3)], True)), json_response(runs_page([rid(2)], False))
    )
    seen = [str(r.id) for r in twigg.chat(CHAT).runs(limit=2)]
    assert seen == [rid(4), rid(3), rid(2)]
    assert api.requests[0].url.path == f"/api/v1/chats/{CHAT}/runs"
    assert api.requests[1].url.params["after_id"] == rid(3)
    assert api.requests[1].url.params["limit"] == "2"


def test_runs_page_newer_with_before_id_and_yield_oldest_first() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response(runs_page([rid(6), rid(5)], True)), json_response(runs_page([rid(7)], False))
    )
    seen = [str(r.id) for r in twigg.chats.runs_by_external_id("wa:1", before_id=rid(4))]
    assert seen == [rid(5), rid(6), rid(7)]
    assert api.requests[1].url.params["before_id"] == rid(6)
    assert "after_id" not in api.requests[1].url.params


def test_deletes_chats_and_configuration_under_a_prefix() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response({"deleted": 3}),
        json_response(
            {"instructions": 1, "tools": 0, "retention_policies": 0, "context_budgets": 2}
        ),
    )
    assert twigg.chats.delete_by_namespace("swarm/run-abc").deleted == 3
    assert api.last.method == "DELETE"
    assert api.last.url.path == "/api/v1/chats"
    assert api.last.url.params["namespace_prefix"] == "swarm/run-abc"
    assert twigg.config.delete("swarm/run-abc").context_budgets == 2
    assert api.last.method == "DELETE"
    assert api.last.url.path == "/api/v1/config"
    assert api.last.url.params["namespace_prefix"] == "swarm/run-abc"


def test_scopes_delete_their_own_namespace() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response({"deleted": 0}),
        json_response(
            {"instructions": 0, "tools": 0, "retention_policies": 0, "context_budgets": 0}
        ),
    )
    scope = twigg.namespace("swarm").child("run-abc")
    scope.chats.delete_all()
    assert api.last.url.path == "/api/v1/chats"
    assert api.last.url.params["namespace_prefix"] == "swarm/run-abc"
    scope.config.delete()
    assert api.last.url.path == "/api/v1/config"
    assert api.last.url.params["namespace_prefix"] == "swarm/run-abc"


@pytest.mark.parametrize("value", [True, False])
def test_history_asks_for_client_data_as_a_lowercase_boolean(value: bool) -> None:
    twigg, api, _ = setup()
    api.reply(json_response(history_page([])))
    twigg.chat(CHAT).history(include_client_data=value)
    assert api.last.url.params["include_client_data"] == str(value).lower()


def test_client_data_goes_out_on_a_ready_made_part() -> None:
    twigg, api, _ = setup()
    part = {"type": "prompt", "text": "hi", "client_data": {"ui": "msg-7"}}
    api.reply(sse_response(text_turn()))
    twigg.chat(CHAT, model="m").send(part)
    assert api.body()["input"] == [part]
