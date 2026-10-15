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
from .chat import AsyncChat
from .pagination import AsyncPage
from .resources import (
    AsyncBudgets,
    AsyncChats,
    AsyncConfig,
    AsyncInstructions,
    AsyncRetention,
    AsyncTools,
    AsyncUsageResource,
    Id,
    UsageDimension,
)


class AsyncScopedChats:
    def __init__(self, scope: AsyncNamespaceScope) -> None:
        self._scope = scope

    async def create(
        self,
        *,
        title: str | None = None,
        description: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> ChatCreated:
        return await self._scope._chats.create(
            namespace=self._scope.namespace,
            title=title,
            description=description,
            user_metadata=user_metadata,
            options=options,
        )

    async def open(
        self,
        *,
        defaults: TurnFields | None = None,
        title: str | None = None,
        description: str | None = None,
        user_metadata: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> AsyncChat:
        """Create a chat in this namespace and return a handle on it."""
        return await self._scope._chats.open(
            defaults=defaults,
            namespace=self._scope.namespace,
            title=title,
            description=description,
            user_metadata=user_metadata,
            options=options,
        )

    async def list(
        self,
        *,
        after_id: Id | None = None,
        before_id: Id | None = None,
        limit: int | None = None,
        options: RequestOptions | None = None,
    ) -> AsyncPage[ChatSummary]:
        """Chats in this namespace and everything beneath it."""
        return await self._scope._chats.list(
            namespace=self._scope.namespace,
            after_id=after_id,
            before_id=before_id,
            limit=limit,
            options=options,
        )


class AsyncScopedInstructions:
    def __init__(self, scope: AsyncNamespaceScope, surface: AsyncInstructions) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    async def publish(
        self,
        *,
        body: str,
        mode: Literal["append", "replace"] = "append",
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        return await self._surface.publish(
            body=body, mode=mode, namespace=self._namespace, options=options
        )

    async def versions(
        self, *, options: RequestOptions | None = None
    ) -> list[ConfigVersionResponse]:
        return await self._surface.versions(namespace=self._namespace, options=options)

    async def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return await self._surface.withdraw(namespace=self._namespace, options=options)


class AsyncScopedTools:
    def __init__(self, scope: AsyncNamespaceScope, surface: AsyncTools) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    async def publish(
        self,
        *,
        definitions: Sequence[Any],
        mode: Literal["append", "replace"] = "append",
        options: RequestOptions | None = None,
    ) -> ConfigVersionResponse:
        """Publish a bundle. `definitions` are tool definitions or `@tool` objects."""
        return await self._surface.publish(
            definitions=definitions, mode=mode, namespace=self._namespace, options=options
        )

    async def versions(
        self, *, options: RequestOptions | None = None
    ) -> list[ConfigVersionResponse]:
        return await self._surface.versions(namespace=self._namespace, options=options)

    async def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return await self._surface.withdraw(namespace=self._namespace, options=options)


class AsyncScopedBudgets:
    def __init__(self, scope: AsyncNamespaceScope, surface: AsyncBudgets) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    async def publish(
        self,
        *,
        budget: Mapping[str, Any],
        model_ids: Sequence[Id] | None = None,
        options: RequestOptions | None = None,
    ) -> list[ContextBudgetResponse]:
        return await self._surface.publish(
            budget=budget, model_ids=model_ids, namespace=self._namespace, options=options
        )

    async def active(self, *, options: RequestOptions | None = None) -> list[ContextBudgetResponse]:
        return await self._surface.active(namespace=self._namespace, options=options)

    async def versions(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> list[ContextBudgetResponse]:
        return await self._surface.versions(namespace=self._namespace, model=model, options=options)

    async def withdraw(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> DeactivateResponse:
        """Remove this namespace's budget for `model`, or its default budget."""
        return await self._surface.withdraw(namespace=self._namespace, model=model, options=options)


class AsyncScopedRetention:
    def __init__(self, scope: AsyncNamespaceScope, surface: AsyncRetention) -> None:
        self._namespace = scope.namespace
        self._surface = surface

    async def publish(
        self, *, rules: Mapping[str, Any], options: RequestOptions | None = None
    ) -> RetentionPolicyResponse:
        return await self._surface.publish(rules=rules, namespace=self._namespace, options=options)

    async def versions(
        self, *, options: RequestOptions | None = None
    ) -> list[RetentionPolicyResponse]:
        return await self._surface.versions(namespace=self._namespace, options=options)

    async def withdraw(self, *, options: RequestOptions | None = None) -> DeactivateResponse:
        """Remove this namespace's override so it inherits from its parent."""
        return await self._surface.withdraw(namespace=self._namespace, options=options)


class AsyncScopedConfig:
    def __init__(self, scope: AsyncNamespaceScope, config: AsyncConfig) -> None:
        self._scope = scope
        self._config = config
        self.instructions = AsyncScopedInstructions(scope, config.instructions)
        self.tools = AsyncScopedTools(scope, config.tools)
        self.budgets = AsyncScopedBudgets(scope, config.budgets)
        self.retention = AsyncScopedRetention(scope, config.retention)

    async def resolve(self, *, options: RequestOptions | None = None) -> ResolvedConfig:
        """The effective configuration here, after inheritance."""
        return await self._config.resolve(namespace=self._scope.namespace, options=options)

    async def resolve_budget(
        self, *, model: Id | None = None, options: RequestOptions | None = None
    ) -> ResolvedBudget:
        return await self._config.resolve_budget(
            namespace=self._scope.namespace, model=model, options=options
        )


class AsyncScopedUsage:
    def __init__(self, scope: AsyncNamespaceScope, usage: AsyncUsageResource) -> None:
        self._scope = scope
        self._usage = usage

    async def query(
        self,
        *,
        range: Literal["24h", "7d", "30d", "90d"],
        bin: Literal["hour", "day"] | None = None,
        group_by: UsageDimension | None = None,
        options: RequestOptions | None = None,
    ) -> UsageReport:
        """Usage for this namespace and everything beneath it."""
        return await self._usage.query(
            range=range,
            bin=bin,
            group_by=group_by,
            namespace=self._scope.namespace,
            options=options,
        )


class AsyncNamespaceScope:
    def __init__(
        self,
        namespace: str,
        chats: AsyncChats,
        config: AsyncConfig,
        usage: AsyncUsageResource,
    ) -> None:
        self.namespace = namespace
        self._chats = chats
        self._config_resource = config
        self._usage_resource = usage
        self.chats = AsyncScopedChats(self)
        self.config = AsyncScopedConfig(self, config)
        self.usage = AsyncScopedUsage(self, usage)

    def child(self, name: str) -> AsyncNamespaceScope:
        """A scope beneath this one: `acme` then `support` is `acme/support`."""
        return AsyncNamespaceScope(
            f"{self.namespace}/{name}",
            self._chats,
            self._config_resource,
            self._usage_resource,
        )

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.namespace!r})"
