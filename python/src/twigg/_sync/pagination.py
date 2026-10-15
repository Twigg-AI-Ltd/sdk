# Generated from src/twigg/_async/pagination.py by scripts/unasync.py. Do not edit.
"""Pages that know how to fetch the next one. Iterating a page walks every item from it onward,
fetching pages as needed."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class Page(Generic[T]):
    def __init__(
        self,
        data: list[T],
        has_more: bool,
        fetch_next: Callable[[], Page[T]] | None,
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

    def next_page(self) -> Page[T] | None:
        """The next page in the direction being paged, or `None` at the end."""
        if not self.has_next_page() or self._fetch_next is None:
            return None
        return self._fetch_next()

    def iter_pages(self) -> Iterator[Page[T]]:
        """This page and every following one."""
        page: Page[T] | None = self
        while page is not None:
            yield page
            page = page.next_page()

    def __iter__(self) -> Iterator[T]:
        for page in self.iter_pages():
            for item in reversed(page.data) if page._reverse else page.data:
                yield item

    def __repr__(self) -> str:
        return f"{type(self).__name__}(data={len(self.data)} items, has_more={self.has_more})"


class HistoryPage(Page[T]):
    """A page of chat history, with its ordinal cursors."""

    @property
    def first_ordinal(self) -> int | None:
        """Ordinal of the first part in `data`; `None` when the page is empty."""
        return getattr(self.response, "first_ordinal", None)

    @property
    def last_ordinal(self) -> int | None:
        """Ordinal of the last part in `data`; `None` when the page is empty."""
        return getattr(self.response, "last_ordinal", None)
