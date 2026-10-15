# Generated from src/twigg/_async/resources.py by scripts/unasync.py. Do not edit.
"""Resource namespaces. Each method describes one request and parses its answer."""

from __future__ import annotations

import builtins
import time
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, TypeAdapter, ValidationError

from .._generated.models import (
    AbortAccepted,
    ApiVersion,
    Catalogue,
    CatalogueModel,
    CatalogueModelResponse,
    ChatCreated,
    ChatPage,
    ChatSummary,
    ConfigVersionResponse,
    ContextBudgetResponse,
    DeactivateResponse,
    DefaultPoliciesResponse,
    Discovery,
    HistoryPageResponse,
    HistoryPart,
    InstructionResponse,
    NamespacePage,
    PublicPlatformUpdate,
    ResolvedBudget,
    ResolvedConfig,
    RetentionPolicyResponse,
    RunInspection,
    ToolSchemaResponse,
    UsageReport,
)
from .._shared.options import TurnFields
from .._shared.recovery import is_finished
from .._shared.request import ApiRequest, RequestOptions, compact, segment
from ..errors import APITimeoutError, invalid_response
from .pagination import HistoryPage, Page
from .transport import Transport

if TYPE_CHECKING:
    from .chat import Chat

M = TypeVar("M", bound=BaseModel)
Id = str | UUID
UsageDimension = Literal["model", "namespace", "api_key", "organisation", "entry_type", "run"]
_adapters: dict[Any, TypeAdapter[Any]] = {}


def _parse(model: type[M], data: Any) -> M:
    """Validate a response, as a TwiggError when it is not the shape the API documents."""
    try:
        return model.model_validate(data)
    except ValidationError as error:
        raise invalid_response(model.__name__, error) from error


def _list_of(model: type[M], data: Any) -> list[M]:
    adapter = _adapters.get(model)
    if adapter is None:
        adapter = _adapters[model] = TypeAdapter(list[model])  # pyright: ignore[reportInvalidTypeForm]
    try:
        return adapter.validate_python(data)
    except ValidationError as error:
        raise invalid_response(f"list of {model.__name__}", error) from error


class Resource:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def _get(
        self,
        path: str,
        query: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
        *,
        auth: Literal["required", "optional"] = "required",
    ) -> Any:
        return self._transport.json(
            ApiRequest("GET", path, query=query, auth=auth, idempotent=True), options
        )

    def _post(
        self,
        path: str,
        body: Any = None,
        options: RequestOptions | None = None,
        *,
        query: Mapping[str, Any] | None = None,
        idempotent: bool = False,
    ) -> Any:
        return self._transport.json(
            ApiRequest("POST", path, query=query, body=body, idempotent=idempotent), options
        )

    def _delete(
        self, path: str, query: Mapping[str, Any] | None, options: RequestOptions | None
    ) -> Any:
        return self._transport.json(ApiRequest("DELETE", path, query=query), options)


class Chats(Resource):
    #: Set by the client so `open` can return a chat handle.
    _handle: Callable[[ChatCreated, TurnFields | None], Chat] | None = None

    def open(
        self,
        *,
        defaults: TurnFields | None = None,
        namespace: str | None = None,
        title: str | None = None,
        description: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> Chat:
        """Create a chat and return a handle on it. `defaults` fill request fields such as
        `model` on every turn."""
        created = self.create(
            namespace=namespace,
            title=title,
            description=description,
            user_metadata=user_metadata,
            options=options,
        )
        if self._handle is None:
            raise RuntimeError("chats.open needs a client")
        return self._handle(created, defaults)

    def create(
        self,
        *,
        namespace: str | None = None,
        title: str | None = None,
        description: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> ChatCreated:
        """Open a chat. Every field is optional; the namespace is immutable once set."""
        body = compact(
            namespace=namespace, title=title, description=description, user_metadata=user_metadata
        )
        return _parse(ChatCreated, self._post("/api/v1/chats", body, options))

    def get(self, chat_id: Id, *, options: RequestOptions | None = None) -> ChatSummary:
        data = self._get(f"/api/v1/chats/{segment(chat_id)}", options=options)
        return _parse(ChatSummary, data)

    def delete(self, chat_id: Id, *, options: RequestOptions | None = None) -> None:
        self._delete(f"/api/v1/chats/{segment(chat_id)}", None, options)

    def list(
        self,
        *,
        namespace: str | None = None,
        after_id: Id | None = None,
        before_id: Id | None = None,
        limit: int | None = None,
        options: RequestOptions | None = None,
    ) -> Page[ChatSummary]:
        """List chats, newest first. A `namespace` includes everything beneath it.

        Iterating walks towards older chats by default. Passing `before_id` pages towards newer
        chats instead, and iteration then yields them oldest first."""
        newer = before_id is not None

        def load(query: dict[str, Any]) -> Page[ChatSummary]:
            page = _parse(ChatPage, self._get("/api/v1/chats", query, options))
            cursor = page.first_id if newer else page.last_id
            step = (
                None
                if cursor is None
                else (lambda: load({**query, ("before_id" if newer else "after_id"): str(cursor)}))
            )
            return Page(page.data, page.has_more, step, reverse=newer, response=page)

        return load(
            compact(namespace=namespace, after_id=after_id, before_id=before_id, limit=limit)
        )

    def history(
        self,
        chat_id: Id,
        *,
        before_ordinal: int | None = None,
        after_ordinal: int | None = None,
        limit: int | None = None,
        include: Literal["stubs", "none", "full"] | None = None,
        options: RequestOptions | None = None,
    ) -> HistoryPage[HistoryPart]:
        """Read a chat's parts. Each page holds parts oldest first; with no cursor it is the
        newest page.

        Iterating walks backwards from there, yielding parts newest first, which is what a
        transcript view loading upwards wants. Passing `after_ordinal` pages forwards instead
        and yields parts oldest first."""
        forward = after_ordinal is not None
        path = f"/api/v1/chats/{segment(chat_id)}/history"

        def load(query: dict[str, Any]) -> HistoryPage[HistoryPart]:
            page = _parse(HistoryPageResponse, self._get(path, query, options))
            cursor = page.last_ordinal if forward else page.first_ordinal
            step = (
                None
                if cursor is None
                else (
                    lambda: load(
                        {**query, ("after_ordinal" if forward else "before_ordinal"): cursor}
                    )
                )
            )
            return HistoryPage(page.data, page.has_more, step, reverse=not forward, response=page)

        return load(
            compact(
                before_ordinal=before_ordinal,
                after_ordinal=after_ordinal,
                limit=limit,
                include=include,
            )
        )


class Runs(Resource):
    def get(self, run_id: Id, *, options: RequestOptions | None = None) -> RunInspection:
        """A run's status, usage, cost once settled, and the configuration it used."""
        data = self._get(f"/api/v1/runs/{segment(run_id)}", options=options)
        return _parse(RunInspection, data)

    def wait_for_settlement(
        self, run_id: Id, *, wait: float = 600, options: RequestOptions | None = None
    ) -> RunInspection:
        """Wait until the run's charge has landed, polling with backoff, and return it with
        `cost` set. A turn's result has no cost while settlement is pending, which can lag by
        seconds or, rarely, hours. Raises APITimeoutError after `wait` seconds (default 10
        minutes)."""
        deadline = time.monotonic() + wait
        delay = 1.0
        while True:
            run = self.get(run_id, options=options)
            if run.settled_at is not None or (is_finished(run) and run.cost is not None):
                return run
            if time.monotonic() + delay > deadline:
                raise APITimeoutError(
                    f"Run {run_id} had not settled after {wait:g}s", code="settlement_timeout"
                )
            self._transport.sleep(delay)
            delay = min(delay * 2, 30.0)


class Models(Resource):
    def list(self, *, options: RequestOptions | None = None) -> builtins.list[CatalogueModel]:
        """Models available to this organisation, priced for it. Use `name` as `model`."""
        return _list_of(CatalogueModel, self._get("/api/v1/models", options=options))


class Namespaces(Resource):
    def list(self, *, options: RequestOptions | None = None) -> Page[str]:
        """Every namespace chats use, ascending. Returned as a page, like every other listing,
        so code keeps working if the endpoint starts paginating."""
        page = _parse(NamespacePage, self._get("/api/v1/namespaces", options=options))
        return Page(list(page.data), False, None, response=page)


class UsageResource(Resource):
    def query(
        self,
        *,
        range: Literal["24h", "7d", "30d", "90d"],
        bin: Literal["hour", "day"] | None = None,
        group_by: UsageDimension | None = None,
        namespace: str | None = None,
        options: RequestOptions | None = None,
    ) -> UsageReport:
        """Usage and cost over a window, optionally binned and grouped. A `namespace` includes
        everything beneath it."""
        query = compact(range=range, bin=bin, group_by=group_by, namespace=namespace)
        return _parse(UsageReport, self._get("/api/v1/usage", query, options))


class CatalogueResource(Resource):
    """The public model catalogue. No API key needed; with one, prices reflect the
    organisation's own rate."""

    def list(self, *, options: RequestOptions | None = None) -> Catalogue:
        data = self._get("/v1/catalogue", options=options, auth="optional")
        return _parse(Catalogue, data)

    def get(self, name: str, *, options: RequestOptions | None = None) -> CatalogueModelResponse:
        """One model by catalogue name. Names may contain slashes."""
        path = "/v1/catalogue/" + "/".join(segment(part) for part in name.split("/"))
        return _parse(CatalogueModelResponse, self._get(path, options=options, auth="optional"))

    def markdown(self, *, options: RequestOptions | None = None) -> str:
        """The catalogue as a Markdown table, for prompts and docs."""
        return self._transport.text(
            ApiRequest("GET", "/v1/catalogue/models.md", auth="optional", accept="text/markdown"),
            options,
        )


class Meta(Resource):
    """Discovery, version and platform updates. No API key needed."""

    def discovery(self, *, options: RequestOptions | None = None) -> Discovery:
        """Links to the docs, OpenAPI document and llms.txt."""
        return _parse(Discovery, self._get("/", options=options, auth="optional"))

    def version(self, *, options: RequestOptions | None = None) -> ApiVersion:
        data = self._get("/api/v1/version", options=options, auth="optional")
        return _parse(ApiVersion, data)

    def updates(self, *, options: RequestOptions | None = None) -> list[PublicPlatformUpdate]:
        """Published platform updates: releases, notices and maintenance."""
        data = self._get("/api/v1/updates", options=options, auth="optional")
        return _list_of(PublicPlatformUpdate, data)


class ConfigSurface(Resource):
    """What the four configuration surfaces share. Each is versioned per scope: publishing
    creates a version and activates it, restoring re-activates an older one, and withdrawing
    removes the scope's override so it inherits from its parent."""

    _base = ""

    def _publish(self, body: dict[str, Any], options: RequestOptions | None) -> Any:
        # Not retried on failure: a second publish would be a second version.
        return self._post(self._base, body, options)

    def _restore(self, version_id: Id, options: RequestOptions | None) -> Any:
        # Activating the version that is already active changes nothing, so this may retry.
        path = f"{self._base}/{segment(version_id)}/activate"
        return self._post(path, None, options, idempotent=True)

    def withdraw(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> DeactivateResponse:
        """Remove this scope's override so it inherits from its parent."""
        data = self._delete(f"{self._base}/active", compact(namespace=namespace), options)
        return _parse(DeactivateResponse, data)


class Instructions(ConfigSurface):
    """System instructions. `append` adds to the parent scope's; `replace` cuts the chain."""

    _base = "/api/v1/config/instructions"

    def publish(
        self,
        *,
        body: str,
        mode: Literal["append", "replace"] = "append",
        namespace: str | None = None,
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        data = self._publish(compact(body=body, mode=mode, namespace=namespace), options)
        return _parse(ConfigVersionResponse, data)

    def versions(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> list[ConfigVersionResponse]:
        """Every version in exactly this scope (not its children), without bodies."""
        data = self._get(self._base, compact(namespace=namespace), options)
        return _list_of(ConfigVersionResponse, data)

    def get(self, version_id: Id, *, options: RequestOptions | None = None) -> InstructionResponse:
        """One version with its body."""
        data = self._get(f"{self._base}/{segment(version_id)}", options=options)
        return _parse(InstructionResponse, data)

    def restore(
        self, version_id: Id, *, options: RequestOptions | None = None
    ) -> ConfigVersionResponse:
        return _parse(ConfigVersionResponse, self._restore(version_id, options))


class Tools(ConfigSurface):
    """Saved tool bundles, offered to every run in the scope."""

    _base = "/api/v1/config/tools"

    def publish(
        self,
        *,
        definitions: Sequence[Any],
        mode: Literal["append", "replace"] = "append",
        namespace: str | None = None,
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        """Publish a bundle. `definitions` are tool definitions or `@tool` objects."""
        body = compact(definitions=list(definitions), mode=mode, namespace=namespace)
        return _parse(ConfigVersionResponse, self._publish(body, options))

    def versions(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> list[ConfigVersionResponse]:
        """Every version in exactly this scope (not its children), without definitions."""
        data = self._get(self._base, compact(namespace=namespace), options)
        return _list_of(ConfigVersionResponse, data)

    def get(self, version_id: Id, *, options: RequestOptions | None = None) -> ToolSchemaResponse:
        """One version with its definitions."""
        data = self._get(f"{self._base}/{segment(version_id)}", options=options)
        return _parse(ToolSchemaResponse, data)

    def restore(
        self, version_id: Id, *, options: RequestOptions | None = None
    ) -> ConfigVersionResponse:
        return _parse(ConfigVersionResponse, self._restore(version_id, options))


class Budgets(ConfigSurface):
    """Context budgets. Each scope has a default budget plus optional per-model ones; budgets do
    not combine across scopes, the nearest one wins."""

    _base = "/api/v1/config/budgets"

    def publish(
        self,
        *,
        budget: Mapping[str, Any],
        model_ids: Sequence[Id] | None = None,
        namespace: str | None = None,
        options: RequestOptions | None = None,
    ) -> list[ContextBudgetResponse]:
        """Publish one budget document for each of `model_ids`, or the scope default when there
        are none. Returns one new version per model."""
        ids = None if model_ids is None else [str(m) for m in model_ids]
        body = compact(budget=budget, model_ids=ids, namespace=namespace)
        return _list_of(ContextBudgetResponse, self._publish(body, options))

    def active(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> list[ContextBudgetResponse]:
        """The active budgets in exactly this scope, with their documents."""
        data = self._get(self._base, compact(namespace=namespace), options)
        return _list_of(ContextBudgetResponse, data)

    def versions(
        self,
        *,
        namespace: str | None = None,
        model: Id | None = None,
        options: RequestOptions | None = None,
    ) -> list[ContextBudgetResponse]:
        """Every version in exactly this scope, optionally for one model."""
        query = compact(namespace=namespace, model=None if model is None else str(model))
        return _list_of(ContextBudgetResponse, self._get(f"{self._base}/versions", query, options))

    def restore(
        self, version_id: Id, *, options: RequestOptions | None = None
    ) -> ContextBudgetResponse:
        return _parse(ContextBudgetResponse, self._restore(version_id, options))

    def withdraw(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        *,
        namespace: str | None = None,
        model: Id | None = None,
        options: RequestOptions | None = None,
    ) -> DeactivateResponse:
        """Remove this scope's budget for `model`, or its default budget."""
        query = compact(namespace=namespace, model=None if model is None else str(model))
        return _parse(DeactivateResponse, self._delete(f"{self._base}/active", query, options))


class Retention(ConfigSurface):
    """Retention policies: what of a chat's history is replayed, and how it is cut down."""

    _base = "/api/v1/config/retention"

    def publish(
        self,
        *,
        rules: Mapping[str, Any],
        namespace: str | None = None,
        options: RequestOptions | None = None,
    ) -> RetentionPolicyResponse:
        data = self._publish(compact(rules=rules, namespace=namespace), options)
        return _parse(RetentionPolicyResponse, data)

    def versions(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> list[RetentionPolicyResponse]:
        """Every version in exactly this scope, with its rules."""
        data = self._get(self._base, compact(namespace=namespace), options)
        return _list_of(RetentionPolicyResponse, data)

    def restore(
        self, version_id: Id, *, options: RequestOptions | None = None
    ) -> RetentionPolicyResponse:
        return _parse(RetentionPolicyResponse, self._restore(version_id, options))


class Config(Resource):
    def __init__(self, transport: Transport) -> None:
        super().__init__(transport)
        self.instructions = Instructions(transport)
        self.tools = Tools(transport)
        self.budgets = Budgets(transport)
        self.retention = Retention(transport)

    def resolve(
        self, *, namespace: str | None = None, options: RequestOptions | None = None
    ) -> ResolvedConfig:
        """The effective instructions, tools and retention for a scope, after inheritance."""
        data = self._get("/api/v1/config/resolved", compact(namespace=namespace), options)
        return _parse(ResolvedConfig, data)

    def resolve_budget(
        self,
        *,
        namespace: str | None = None,
        model: Id | None = None,
        options: RequestOptions | None = None,
    ) -> ResolvedBudget:
        """The budget a model would run under in a scope, and where it came from."""
        query = compact(namespace=namespace, model=None if model is None else str(model))
        return _parse(ResolvedBudget, self._get("/api/v1/config/resolved-budget", query, options))

    def defaults(self, *, options: RequestOptions | None = None) -> DefaultPoliciesResponse:
        """The platform defaults used when no scope has published a budget or policy."""
        data = self._get("/api/v1/config/defaults", options=options)
        return _parse(DefaultPoliciesResponse, data)

    def namespaces(self, *, options: RequestOptions | None = None) -> list[str]:
        """Every namespace with configuration or chats."""
        return list(self._get("/api/v1/config/namespaces", options=options))


class Aborts(Resource):
    """The abort call, shared by the responses resource and streams."""

    def abort(
        self, chat_id: Id, *, run_id: Id | None = None, options: RequestOptions | None = None
    ) -> AbortAccepted:
        query = compact(run_id=None if run_id is None else str(run_id))
        data = self._post(f"/api/v1/chats/{segment(chat_id)}/abort", None, options, query=query)
        return _parse(AbortAccepted, data)
