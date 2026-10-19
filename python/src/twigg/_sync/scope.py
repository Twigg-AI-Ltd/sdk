# Generated from src/twigg/_async/scope.py by scripts/unasync.py. Do not edit.
"""A client view pinned to one namespace, so multi-tenant code cannot forget the scope."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from .._generated.models import (
    ChatCreated,
    ChatSummary,
    ConfigVersionResponse,
    ContextBudgetResponse,
    DeactivateResponse,
    ResolvedBudget,
    ResolvedConfig,
    RetentionPolicyResponse,
    UsageReport,
)
from .._shared.options import TurnFields
from .._shared.request import RequestOptions
from .chat import Chat
from .pagination import Page
from .resources import (
    Budgets,
    Chats,
    Config,
    Id,
    Instructions,
    Retention,
    Tools,
    UsageDimension,
    UsageResource,
)


class ScopedChats:
    def __init__(self, scope: NamespaceScope) -> None:
        self._scope = scope

    def create(
        self,
        *,
        title: str | None = None,
        description: str | None = None,
        external_id: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> ChatCreated:
        return self._scope._chats.create(
            namespace=self._scope.namespace,
            title=title,
            description=description,
            external_id=external_id,
            user_metadata=user_metadata,
            options=options,
        )

    def open(
        self,
        *,
        defaults: TurnFields | None = None,
        title: str | None = None,
        description: str | None = None,
        external_id: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> Chat:
        """Create a chat in this namespace and return a handle on it."""
        return self._scope._chats.open(
            defaults=defaults,
            namespace=self._scope.namespace,
            title=title,
            description=description,
            external_id=external_id,
            user_metadata=user_metadata,
            options=options,
        )

    def list(
        self,
        *,
        after_id: Id | None = None,
        before_id: Id | None = None,
        limit: int | None = None,
        options: RequestOptions | None = None,
    ) -> Page[ChatSummary]:
        """Chats in this namespace and everything beneath it."""
        return self._scope._chats.list(
            namespace=self._scope.namespace,
            after_id=after_id,
            before_id=before_id,
            limit=limit,
            options=options,
        )


class ScopedInstructions:
    def __init__(self, scope: NamespaceScope, surface: Instructions) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    def publish(
        self,
        *,
        body: str,
        mode: Literal["append", "replace"] = "append",
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        return self._surface.publish(
            body=body, mode=mode, namespace=self._namespace, options=options
        )

    def versions(self, *, options: RequestOptions | None = None) -> list[ConfigVersionResponse]:
        return self._surface.versions(namespace=self._namespace, options=options)

    def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return self._surface.withdraw(namespace=self._namespace, options=options)


class ScopedTools:
    def __init__(self, scope: NamespaceScope, surface: Tools) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    def publish(
        self,
        *,
        definitions: Sequence[Any],
        mode: Literal["append", "replace"] = "append",
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        """Publish a bundle. `definitions` are tool definitions or `@tool` objects."""
        return self._surface.publish(
            definitions=definitions, mode=mode, namespace=self._namespace, options=options
        )

    def versions(self, *, options: RequestOptions | None = None) -> list[ConfigVersionResponse]:
        return self._surface.versions(namespace=self._namespace, options=options)

    def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return self._surface.withdraw(namespace=self._namespace, options=options)


class ScopedBudgets:
    def __init__(self, scope: NamespaceScope, surface: Budgets) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    def publish(
        self,
        *,
        budget: Mapping[str, Any],
        model_ids: Sequence[Id] | None = None,
        options: RequestOptions | None = None,
    ) -> list[ContextBudgetResponse]:
        return self._surface.publish(
            budget=budget, model_ids=model_ids, namespace=self._namespace, options=options
        )

    def active(self, *, options: RequestOptions | None = None) -> list[ContextBudgetResponse]:
        return self._surface.active(namespace=self._namespace, options=options)

    def versions(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> list[ContextBudgetResponse]:
        return self._surface.versions(namespace=self._namespace, model=model, options=options)

    def withdraw(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> DeactivateResponse:
        """Remove this namespace's budget for `model`, or its default budget."""
        return self._surface.withdraw(namespace=self._namespace, model=model, options=options)


class ScopedRetention:
    def __init__(self, scope: NamespaceScope, surface: Retention) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    def publish(
        self, *, rules: Mapping[str, Any], options: RequestOptions | None = None
    ) -> RetentionPolicyResponse:
        return self._surface.publish(rules=rules, namespace=self._namespace, options=options)

    def versions(self, *, options: RequestOptions | None = None) -> list[RetentionPolicyResponse]:
        return self._surface.versions(namespace=self._namespace, options=options)

    def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return self._surface.withdraw(namespace=self._namespace, options=options)


class ScopedConfig:
    def __init__(self, scope: NamespaceScope, config: Config) -> None:
        self._scope = scope
        self._config = config
        self.instructions = ScopedInstructions(scope, config.instructions)
        self.tools = ScopedTools(scope, config.tools)
        self.budgets = ScopedBudgets(scope, config.budgets)
        self.retention = ScopedRetention(scope, config.retention)

    def resolve(self, *, options: RequestOptions | None = None) -> ResolvedConfig:
        """The effective configuration here, after inheritance."""
        return self._config.resolve(namespace=self._scope.namespace, options=options)

    def resolve_budget(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> ResolvedBudget:
        return self._config.resolve_budget(
            namespace=self._scope.namespace, model=model, options=options
        )


class ScopedUsage:
    def __init__(self, scope: NamespaceScope, usage: UsageResource) -> None:
        self._scope = scope
        self._usage = usage

    def query(
        self,
        *,
        range: Literal["24h", "7d", "30d", "90d"],
        bin: Literal["hour", "day"] | None = None,
        group_by: UsageDimension | None = None,
        options: RequestOptions | None = None,
    ) -> UsageReport:
        """Usage for this namespace and everything beneath it."""
        return self._usage.query(
            range=range,
            bin=bin,
            group_by=group_by,
            namespace=self._scope.namespace,
            options=options,
        )


class NamespaceScope:
    def __init__(
        self,
        namespace: str,
        chats: Chats,
        config: Config,
        usage: UsageResource,
    ) -> None:
        self.namespace = namespace
        self._chats = chats
        self._config_resource = config
        self._usage_resource = usage
        self.chats = ScopedChats(self)
        self.config = ScopedConfig(self, config)
        self.usage = ScopedUsage(self, usage)

    def child(self, name: str) -> NamespaceScope:
        """A scope beneath this one: `acme` then `support` is `acme/support`."""
        return NamespaceScope(
            f"{self.namespace}/{name}",
            self._chats,
            self._config_resource,
            self._usage_resource,
        )

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.namespace!r})"
