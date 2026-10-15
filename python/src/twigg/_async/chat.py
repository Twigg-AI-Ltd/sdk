"""A handle on one chat, so the common case never touches `input` lists or repeats the model."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from typing_extensions import Unpack

from .._generated.models import AbortAccepted, ChatCreated, ChatSummary, HistoryPart
from .._shared.input import MessageInput, to_parts
from .._shared.options import RetryFields, ToolLoopFields, TurnFields, pick
from .._shared.request import RequestOptions
from .._shared.result import ResponseResult
from .pagination import AsyncHistoryPage
from .resources import AsyncChats, Id
from .responses import AsyncResponses
from .runner import AsyncToolRunner
from .stream import AsyncResponseStream


class AsyncChat:
    def __init__(
        self,
        chats: AsyncChats,
        responses: AsyncResponses,
        chat_id: Id,
        defaults: Mapping[str, Any] | None = None,
        data: ChatCreated | ChatSummary | None = None,
    ) -> None:
        self._chats = chats
        self._responses = responses
        self.id = str(chat_id)
        #: Request fields filled in when a call leaves them out, such as `model`.
        self.defaults: dict[str, Any] = dict(defaults or {})
        #: The chat's record, when this handle came from `chats.open`, or from a listing or
        #: `get` passed to `twigg.chat`.
        self.data = data

    async def send(self, input: MessageInput, **fields: Unpack[TurnFields]) -> ResponseResult:
        """Send a message and wait for the full answer. `fields` are request fields such as
        `max_tokens`, or stream options such as `recover`; the chat's defaults fill the rest."""
        return await self.stream(input, **fields).final()

    def stream(self, input: MessageInput, **fields: Unpack[TurnFields]) -> AsyncResponseStream:
        """Send a message and stream the answer."""
        request: dict[str, Any] = {**pick(self.defaults, TurnFields), **fields}
        return self._responses.stream(self.id, input=to_parts(input), **request)

    def run_tools(self, input: MessageInput, **fields: Unpack[ToolLoopFields]) -> AsyncToolRunner:
        """Send a message and run the tool loop until the model stops calling tools."""
        request: dict[str, Any] = {**pick(self.defaults, ToolLoopFields), **fields}
        return self._responses.run_tools(self.id, input=to_parts(input), **request)

    def retry(self, run_id: Id, **fields: Unpack[RetryFields]) -> AsyncResponseStream:
        """Retry the latest failed run without adding input."""
        request: dict[str, Any] = {**pick(self.defaults, RetryFields), **fields}
        return self._responses.retry(self.id, run_id, **request)

    async def history(
        self,
        *,
        before_ordinal: int | None = None,
        after_ordinal: int | None = None,
        limit: int | None = None,
        include: Literal["stubs", "none", "full"] | None = None,
        options: RequestOptions | None = None,
    ) -> AsyncHistoryPage[HistoryPart]:
        """Read the chat's parts; see `chats.history`. `after_ordinal=-1` reads from the start,
        oldest first."""
        return await self._chats.history(
            self.id,
            before_ordinal=before_ordinal,
            after_ordinal=after_ordinal,
            limit=limit,
            include=include,
            options=options,
        )

    async def get(self, *, options: RequestOptions | None = None) -> ChatSummary:
        return await self._chats.get(self.id, options=options)

    async def delete(self, *, options: RequestOptions | None = None) -> None:
        await self._chats.delete(self.id, options=options)

    async def abort(
        self, run_id: Id | None = None, *, options: RequestOptions | None = None
    ) -> AbortAccepted:
        """Stop the turn in progress, or only `run_id` when given."""
        return await self._responses.abort(self.id, run_id=run_id, options=options)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.id!r})"
