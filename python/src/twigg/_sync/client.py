# Generated from src/twigg/_async/client.py by scripts/unasync.py. Do not edit.
from __future__ import annotations

from collections.abc import Callable, Mapping
from types import TracebackType

from typing_extensions import Unpack

from .._generated.models import ChatCreated, ChatSummary
from .._shared.options import TurnFields
from .._shared.request import resolve_config
from .._shared.result import TwiggWarning
from ._support import HttpClient, HttpTransport, SleepFn, sleep
from .chat import Chat
from .resources import (
    CatalogueResource,
    Chats,
    Config,
    Id,
    Meta,
    Models,
    Namespaces,
    Runs,
    UsageResource,
)
from .responses import Responses
from .scope import NamespaceScope
from .transport import Transport


class Twigg:
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
        self._transport = Transport(config, self._http, _sleep or sleep)
        self.chats = Chats(self._transport)
        self.runs = Runs(self._transport)
        self.responses = Responses(self._transport, self.chats, self.runs, on_warning, model=model)
        self.models = Models(self._transport)
        self.namespaces = Namespaces(self._transport)
        self.usage = UsageResource(self._transport)
        self.catalogue = CatalogueResource(self._transport)
        self.config = Config(self._transport)
        self.meta = Meta(self._transport)
        self.chats._handle = lambda created, defaults: Chat(
            self.chats, self.responses, created.id, defaults, created
        )

    def chat(self, chat: Id | ChatSummary | ChatCreated, **defaults: Unpack[TurnFields]) -> Chat:
        """A handle on an existing chat, from its id or from a record `chats.list()` or
        `chats.get()` returned (kept as `chat.data`). `defaults` fill request fields such as
        `model`; without one, turns use the client's `model`.

            for summary in twigg.chats.list(namespace=ns): twigg.chat(summary)
        """
        if isinstance(chat, (ChatSummary, ChatCreated)):
            return Chat(self.chats, self.responses, chat.id, defaults, chat)
        return Chat(self.chats, self.responses, chat, defaults)

    def namespace(self, namespace: str) -> NamespaceScope:
        """A view of the client pinned to one namespace."""
        return NamespaceScope(namespace, self.chats, self.config, self.usage)

    def close(self) -> None:
        """Close the HTTP client, if this client created it."""
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Twigg:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
