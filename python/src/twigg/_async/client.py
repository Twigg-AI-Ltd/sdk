from __future__ import annotations

from collections.abc import Callable, Mapping
from types import TracebackType

from typing_extensions import Unpack

from .._generated.models import ChatCreated, ChatSummary
from .._shared.options import TurnFields
from .._shared.request import resolve_config
from .._shared.result import TwiggWarning
from ._support import HttpClient, HttpTransport, SleepFn, sleep
from .chat import AsyncChat
from .resources import (
    AsyncCatalogueResource,
    AsyncChats,
    AsyncConfig,
    AsyncMeta,
    AsyncModels,
    AsyncNamespaces,
    AsyncRuns,
    AsyncUsageResource,
    Id,
)
from .responses import AsyncResponses
from .scope import AsyncNamespaceScope
from .transport import AsyncTransport


class AsyncTwigg:
    """A client for the Twigg API.

    `api_key` defaults to `TWIGG_API_KEY` (only the public calls work without one) and
    `base_url` to `TWIGG_BASE_URL`, then `https://api.twigg.ai`. `timeout` is seconds per
    attempt; `max_retries` covers failures that are safe to repeat."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        http_client: HttpClient | None = None,
        transport: HttpTransport | None = None,
        on_warning: Callable[[TwiggWarning], None] | None = None,
        model: str | None = None,
        _sleep: SleepFn | None = None,
    ) -> None:
        config = resolve_config(api_key, base_url, timeout, max_retries, headers)
        self._owns_http = http_client is None
        self._http = http_client or HttpClient(transport=transport)
        self._transport = AsyncTransport(config, self._http, _sleep or sleep)
        self.chats = AsyncChats(self._transport)
        self.runs = AsyncRuns(self._transport)
        self.responses = AsyncResponses(
            self._transport, self.chats, self.runs, on_warning, model=model
        )
        self.models = AsyncModels(self._transport)
        self.namespaces = AsyncNamespaces(self._transport)
        self.usage = AsyncUsageResource(self._transport)
        self.catalogue = AsyncCatalogueResource(self._transport)
        self.config = AsyncConfig(self._transport)
        self.meta = AsyncMeta(self._transport)
        self.chats._handle = lambda created, defaults: AsyncChat(
            self.chats, self.responses, created.id, defaults, created
        )

    def chat(
        self, chat: Id | ChatSummary | ChatCreated, **defaults: Unpack[TurnFields]
    ) -> AsyncChat:
        """A handle on an existing chat, from its id or from a record `chats.list()` or
        `chats.get()` returned (kept as `chat.data`). `defaults` fill request fields such as
        `model`; without one, turns use the client's `model`.

            for summary in twigg.chats.list(namespace=ns): twigg.chat(summary)
        """
        if isinstance(chat, (ChatSummary, ChatCreated)):
            return AsyncChat(self.chats, self.responses, chat.id, defaults, chat)
        return AsyncChat(self.chats, self.responses, chat, defaults)

    def namespace(self, namespace: str) -> AsyncNamespaceScope:
        """A view of the client pinned to one namespace."""
        return AsyncNamespaceScope(namespace, self.chats, self.config, self.usage)

    async def close(self) -> None:
        """Close the HTTP client, if this client created it."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncTwigg:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()
