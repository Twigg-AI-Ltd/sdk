"""Pages that know how to fetch the next one. Iterating a page walks every item from it onward,
fetching pages as needed."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class AsyncPage(Generic[T]):
    def __init__(
        self,
        data: list[T],
        has_more: bool,
        fetch_next: Callable[[], Awaitable[AsyncPage[T]]] | None,
        *,
        reverse: bool = False,
        response: Any = None,
    ) -> None:
        #: The items on this page, in the order the API returned them.
        self.data = data
        #: Whether the API says more items exist in the direction being paged.
        self.has_more = has_more
        #: The page envelope as the API returned it, cursors included.
        self.response = response
        self._fetch_next = fetch_next
        # Iteration follows the paging direction: the API returns chats newest first and
        # history oldest first whichever way you page, so some directions reverse each page.
        self._reverse = reverse

    def has_next_page(self) -> bool:
        return self.has_more and self._fetch_next is not None

    async def next_page(self) -> AsyncPage[T] | None:
        """The next page in the direction being paged, or `None` at the end."""
        if not self.has_next_page() or self._fetch_next is None:
            return None
        return await self._fetch_next()

    async def iter_pages(self) -> AsyncIterator[AsyncPage[T]]:
        """This page and every following one."""
        page: AsyncPage[T] | None = self
        while page is not None:
            yield page
            page = await page.next_page()

    async def __aiter__(self) -> AsyncIterator[T]:
        async for page in self.iter_pages():
            for item in reversed(page.data) if page._reverse else page.data:
                yield item

    def __repr__(self) -> str:
        return f"{type(self).__name__}(data={len(self.data)} items, has_more={self.has_more})"


class AsyncHistoryPage(AsyncPage[T]):
    """A page of chat history, with its ordinal cursors."""

    @property
    def first_ordinal(self) -> int | None:
        """Ordinal of the first part in `data`; `None` when the page is empty."""
        return getattr(self.response, "first_ordinal", None)

    @property
    def last_ordinal(self) -> int | None:
        """Ordinal of the last part in `data`; `None` when the page is empty."""
        return getattr(self.response, "last_ordinal", None)
