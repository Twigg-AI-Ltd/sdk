"""Every operation in the pinned spec is covered by an SDK call that sends the method, path and
query parameters the spec declares."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from twigg import Twigg

from .helpers import (
    chat_summary,
    history_page,
    json_response,
    run_record,
    setup,
    sse_response,
    text_turn,
)

SPEC = json.loads((Path(__file__).resolve().parents[2] / "spec/openapi.json").read_text())
OPERATIONS = [
    {**op, "path": path, "method": method.upper()}
    for path, item in SPEC["paths"].items()
    for method, op in item.items()
]
ID = "0192f0a0-0000-7000-8000-000000000001"
VERSION = {
    "id": ID,
    "version": 1,
    "estimated_tokens": 0,
    "is_active": True,
    "created_at": "2026-10-14T00:00:00Z",
}
CHAT: dict[str, Any] = {
    "id": ID,
    "namespace": None,
    "title": None,
    "description": None,
    "user_metadata": {},
    "created_at": "2026-10-14T00:00:00Z",
}
PAGE: dict[str, Any] = {"data": [], "first_id": None, "last_id": None, "has_more": False}
BUDGET = {"version": 3, "headroom": 0.1}
RULES = {"version": 3}
DONE = {"was_active": True}

Call = Callable[[Twigg], Any]
CALLS: dict[str, tuple[Call, Any]] = {
    "discovery": (
        lambda t: t.meta.discovery(),
        {"service": "", "versions": {}, "openapi": "", "docs": "", "llms_txt": ""},
    ),
    "get": (lambda t: t.meta.version(), {"version": "", "commit": "", "api_version": ""}),
    "listPublicUpdates": (lambda t: t.meta.updates(), []),
    "listChats": (lambda t: t.chats.list(namespace="acme", after_id=ID, limit=10), PAGE),
    "createChat": (lambda t: t.chats.create(namespace="acme", title="Billing"), CHAT),
    "getChat": (lambda t: t.chats.get(ID), chat_summary(1)),
    "deleteChat": (lambda t: t.chats.delete(ID), None),
    "getChatHistory": (
        lambda t: t.chats.history(ID, before_ordinal=9, limit=5, include="none"),
        history_page([]),
    ),
    "createResponse": (
        lambda t: t.responses.stream(
            ID, model="m", input=[{"type": "prompt", "text": "Hi"}]
        ).final(),
        "sse",
    ),
    "abortResponse": (
        lambda t: t.responses.abort(ID, run_id=ID),
        {"run_id": ID, "chat_id": ID, "status": "aborting"},
    ),
    "getRun": (lambda t: t.runs.get(ID), run_record("succeeded")),
    "listModels": (lambda t: t.models.list(), []),
    "listNamespaces": (lambda t: t.namespaces.list(), {"data": []}),
    "queryUsage": (
        lambda t: t.usage.query(range="7d", bin="day", group_by="model", namespace="acme"),
        "skip-parse",
    ),
    "listCatalogue": (
        lambda t: t.catalogue.list(),
        {"models": [], "markup_percent": "0", "organisation_specific": False},
    ),
    "getCatalogueModel": (lambda t: t.catalogue.get("claude-opus-5"), "skip-parse"),
    "getCatalogueMarkdown": (lambda t: t.catalogue.markdown(), "text"),
    "getConfigurationDefaults": (lambda t: t.config.defaults(), "skip-parse"),
    "listConfigurationNamespaces": (lambda t: t.config.namespaces(), []),
    "resolveConfiguration": (lambda t: t.config.resolve(namespace="acme"), "skip-parse"),
    "resolveContextBudget": (
        lambda t: t.config.resolve_budget(namespace="acme", model=ID),
        "skip-parse",
    ),
    "publishInstructions": (lambda t: t.config.instructions.publish(body="Be brief."), VERSION),
    "listInstructionVersions": (lambda t: t.config.instructions.versions(namespace="acme"), []),
    "getInstructions": (lambda t: t.config.instructions.get(ID), {**VERSION, "body": ""}),
    "restoreInstructions": (lambda t: t.config.instructions.restore(ID), VERSION),
    "withdrawInstructions": (lambda t: t.config.instructions.withdraw(namespace="acme"), DONE),
    "publishTools": (lambda t: t.config.tools.publish(definitions=[]), VERSION),
    "listToolVersions": (lambda t: t.config.tools.versions(namespace="acme"), []),
    "getTools": (lambda t: t.config.tools.get(ID), {**VERSION, "definitions": []}),
    "restoreTools": (lambda t: t.config.tools.restore(ID), VERSION),
    "withdrawTools": (lambda t: t.config.tools.withdraw(namespace="acme"), DONE),
    "publishBudgets": (lambda t: t.config.budgets.publish(budget=BUDGET), []),
    "listActiveBudgets": (lambda t: t.config.budgets.active(namespace="acme"), []),
    "listBudgetVersions": (lambda t: t.config.budgets.versions(namespace="acme", model=ID), []),
    "restoreBudget": (lambda t: t.config.budgets.restore(ID), {**VERSION, "budget": BUDGET}),
    "withdrawBudget": (lambda t: t.config.budgets.withdraw(namespace="acme", model=ID), DONE),
    "publishRetention": (
        lambda t: t.config.retention.publish(rules=RULES),
        {**VERSION, "rules": RULES},
    ),
    "listRetentionVersions": (lambda t: t.config.retention.versions(namespace="acme"), []),
    "restoreRetention": (lambda t: t.config.retention.restore(ID), {**VERSION, "rules": RULES}),
    "withdrawRetention": (lambda t: t.config.retention.withdraw(namespace="acme"), DONE),
}


def test_covers_every_operation() -> None:
    ids = {op["operationId"] for op in OPERATIONS}
    assert sorted(ids - CALLS.keys()) == []
    assert sorted(CALLS.keys() - ids) == []


@pytest.mark.parametrize("op", OPERATIONS, ids=[op["operationId"] for op in OPERATIONS])
def test_sends_the_declared_method_and_path(op: dict[str, Any]) -> None:
    twigg, api, _ = setup()
    call, reply = CALLS[op["operationId"]]
    if reply == "sse":
        api.reply(sse_response(text_turn()))
    elif reply == "text":
        api.reply(httpx.Response(200, text="|"))
    elif reply is None:
        api.reply(httpx.Response(204))
    elif reply == "skip-parse":
        api.reply(json_response({}))
    else:
        api.reply(json_response(reply))
    try:
        call(twigg)
    except Exception as error:  # a stub body may not parse; the request is what is checked
        if reply != "skip-parse":
            raise error
    sent = api.requests[0]
    assert sent.method == op["method"]
    assert re.fullmatch(re.sub(r"\{[^}]+\}", "[^/]+", op["path"]), sent.url.path)
    declared = {p["name"] for p in op.get("parameters", []) if p["in"] == "query"}
    assert set(sent.url.params.keys()) <= declared
