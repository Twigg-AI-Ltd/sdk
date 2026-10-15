from __future__ import annotations

from .helpers import CHAT, chat_summary, history_page, json_response, part, setup


def chat_page(indexes: list[int], has_more: bool) -> dict[str, object]:
    data = [chat_summary(i) for i in indexes]
    return {
        "data": data,
        "first_id": data[0]["id"] if data else None,
        "last_id": data[-1]["id"] if data else None,
        "has_more": has_more,
    }


def prompt(ordinal: int) -> dict[str, object]:
    return part(ordinal, "user", {"type": "prompt", "text": str(ordinal)})


def test_iterates_every_chat_paging_older() -> None:
    twigg, api, _ = setup()
    api.reply(json_response(chat_page([4, 3], True)), json_response(chat_page([2, 1], False)))
    page = twigg.chats.list(namespace="acme", limit=2)
    ids = [str(c.id)[-1] for c in page]
    assert ids == ["4", "3", "2", "1"]
    second = api.requests[1].url.params
    assert second["after_id"].endswith("3")
    assert second["namespace"] == "acme"
    assert "before_id" not in second


def test_pages_newer_with_before_id_and_yields_oldest_first() -> None:
    twigg, api, _ = setup()
    api.reply(json_response(chat_page([6, 5], True)), json_response(chat_page([8, 7], False)))
    ids = [str(c.id)[-1] for c in twigg.chats.list(before_id="x")]
    assert ids == ["5", "6", "7", "8"]
    assert api.requests[1].url.params["before_id"].endswith("6")


def test_manual_paging() -> None:
    twigg, api, _ = setup()
    api.reply(json_response(chat_page([2], True)), json_response(chat_page([1], False)))
    page = twigg.chats.list()
    assert len(page.data) == 1
    following = page.next_page()
    assert following is not None
    assert following.next_page() is None
    api.reply(json_response(chat_page([1], False)))
    assert len(list(page.iter_pages())) == 2


def test_history_walks_backwards_newest_first() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response(history_page([prompt(3), prompt(4)], True)),
        json_response(history_page([prompt(1), prompt(2)], False)),
    )
    ordinals = [p.ordinal for p in twigg.chats.history(CHAT, limit=2)]
    assert ordinals == [4, 3, 2, 1]
    assert api.requests[1].url.params["before_ordinal"] == "3"


def test_history_pages_forwards_from_after_ordinal() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response(history_page([prompt(5), prompt(6)], True)),
        json_response(history_page([prompt(7)], False)),
    )
    ordinals = [p.ordinal for p in twigg.chats.history(CHAT, after_ordinal=4)]
    assert ordinals == [5, 6, 7]
    params = api.requests[1].url.params
    assert params["after_ordinal"] == "6"
    assert "before_ordinal" not in params


def test_history_exposes_ordinals_and_keeps_include() -> None:
    twigg, api, _ = setup()
    api.reply(
        json_response(history_page([prompt(9)], True)), json_response(history_page([], False))
    )
    page = twigg.chats.history(CHAT, include="full")
    assert (page.first_ordinal, page.last_ordinal) == (9, 9)
    page.next_page()
    assert api.requests[1].url.params["include"] == "full"


def test_namespaces_come_back_as_a_page() -> None:
    twigg, api, _ = setup()
    api.reply(json_response({"data": ["acme", "acme/support"]}))
    assert list(twigg.namespaces.list()) == ["acme", "acme/support"]
