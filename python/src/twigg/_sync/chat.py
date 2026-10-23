# Generated from src/twigg/_async/chat.py by scripts/unasync.py. Do not edit.
"""A handle on one chat, so the common case never touches `input` lists or repeats the model."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel
from typing_extensions import Unpack

from .._generated.models import (
    AbortAccepted,
    ChatCreated,
    ChatSummary,
    HistoryPart,
    ImportChatResponse,
    ImportSkippedResponse,
)
from .._shared.input import MessageInput, to_parts
from .._shared.options import RetryFields, ToolLoopFields, TurnFields, pick
from .._shared.request import RequestOptions, compact
from .._shared.result import ResponseResult
from .pagination import HistoryPage
from .resources import ChatRef, Chats, ExternalRef, Id
from .responses import Responses
from .runner import ToolRunner
from .stream import ResponseStream


class _AsyncChatHandle:
    """What a chat handle's calls share, whichever way the handle addresses the chat."""

    _ref: ChatRef
    #: Sent with every turn, for a handle that creates its chat on first use.
    _create: Mapping[str, Any] | None = None

    def __init__(
        self,
        chats: Chats,
        responses: Responses,
        defaults: Mapping[str, Any] | None = None,
    ) -> None:
        self._chats = chats
        self._responses = responses
        #: Request fields filled in when a call leaves them out, such as `model`.
        self.defaults: dict[str, Any] = dict(defaults or {})

    def send(self, input: MessageInput, **fields: Unpack[TurnFields]) -> ResponseResult:
        """Send a message and wait for the full answer. `fields` are request fields such as
        `max_tokens`, or stream options such as `recover`; the chat's defaults fill the rest."""
        return self.stream(input, **fields).final()

    def stream(self, input: MessageInput, **fields: Unpack[TurnFields]) -> ResponseStream:
        """Send a message and stream the answer."""
        request: dict[str, Any] = {**pick(self.defaults, TurnFields), **fields}
        return self._responses._stream(
            self._ref, input=to_parts(input), chat=self._create, **request
        )

    def run_tools(self, input: MessageInput, **fields: Unpack[ToolLoopFields]) -> ToolRunner:
        """Send a message and run the tool loop until the model stops calling tools."""
        request: dict[str, Any] = {**pick(self.defaults, ToolLoopFields), **fields}
        return self._responses._run_tools(
            self._ref, input=to_parts(input), chat=self._create, **request
        )

    def retry(self, run_id: Id, **fields: Unpack[RetryFields]) -> ResponseStream:
        """Retry the latest failed run without adding input."""
        request: dict[str, Any] = {**pick(self.defaults, RetryFields), **fields}
        return self._responses._stream(self._ref, input=[], retry_of=run_id, **request)

    def history(
        self,
        *,
        before_ordinal: int | None = None,
        after_ordinal: int | None = None,
        limit: int | None = None,
        include: Literal["stubs", "none", "full"] | None = None,
        options: RequestOptions | None = None,
    ) -> HistoryPage[HistoryPart]:
        """Read the chat's parts; see `chats.history`. `after_ordinal=-1` reads from the start,
        oldest first."""
        query = compact(
            before_ordinal=before_ordinal, after_ordinal=after_ordinal, limit=limit, include=include
        )
        return self._chats._history_at(self._ref, query, options)

    def get(self, *, options: RequestOptions | None = None) -> ChatSummary:
        return self._chats._get_at(self._ref, options)

    def delete(self, *, options: RequestOptions | None = None) -> None:
        self._chats._delete_at(self._ref, options)

    def abort(
        self, run_id: Id | None = None, *, options: RequestOptions | None = None
    ) -> AbortAccepted:
        """Stop the turn in progress, or only `run_id` when given."""
        return self._responses._aborts.abort(self._ref, run_id=run_id, options=options)


class Chat(_AsyncChatHandle):
    def __init__(
        self,
        chats: Chats,
        responses: Responses,
        chat_id: Id,
        defaults: Mapping[str, Any] | None = None,
        data: ChatCreated | ChatSummary | None = None,
    ) -> None:
        super().__init__(chats, responses, defaults)
        self.id = str(chat_id)
        self._ref = self.id
        #: The chat's record, when this handle came from `chats.open`, or from a listing or
        #: `get` passed to `twigg.chat`.
        self.data = data

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.id!r})"


class ExternalChat(_AsyncChatHandle):
    """A handle on the chat holding an external id, your own identifier for it such as a phone
    number. Every call addresses the chat by that id, so none needs Twigg's chat id, and the
    first turn creates the chat if no chat holds the id yet: one request per message."""

    def __init__(
        self,
        chats: Chats,
        responses: Responses,
        external_id: str,
        defaults: Mapping[str, Any] | None = None,
        chat: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(chats, responses, defaults)
        self.external_id = external_id
        self._ref = ExternalRef(external_id)
        #: How to create the chat if no chat holds the id yet. On an existing chat it is
        #: ignored, except that a differing `namespace` is refused with 409.
        self._create = chat

    def import_history(
        self,
        parts: Sequence[Mapping[str, Any] | BaseModel],
        *,
        options: RequestOptions | None = None,
    ) -> ImportChatResponse | ImportSkippedResponse:
        """Store an existing conversation as this chat's history, creating the chat from the
        handle's `chat` if no chat holds the id yet; see `chats.import_by_external_id`. A chat
        that already has history answers `skipped=True` and is left as it was."""
        return self._chats.import_by_external_id(
            self.external_id, parts, chat=self._create, options=options
        )

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.external_id!r})"
