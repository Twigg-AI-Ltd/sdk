"""What genuinely differs between the async and sync clients: the sync twin of
`_async/_support.py`. Hand-written; everything else in `_sync` is generated."""

from __future__ import annotations

import contextlib
import inspect
import threading
import time
from collections.abc import Callable, Generator, Sequence
from typing import Any, TypeVar

import httpx

T = TypeVar("T")
R = TypeVar("R")

HttpClient = httpx.Client
HttpTransport = httpx.BaseTransport
SleepFn = Callable[[float], None]


# Reentrant, as the no-op lock it replaced was: a callback on the reading thread may touch the
# stream again. Real locking matters for close() and abort() from another thread.
Lock = threading.RLock


def sleep(seconds: float) -> None:
    time.sleep(seconds)


@contextlib.contextmanager
def try_acquire(lock: threading.RLock) -> Generator[bool, None, None]:
    """Hold `lock` for the block if it is free, without waiting for it."""
    acquired = lock.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            lock.release()


def call_tool(fn: Callable[..., Any], *args: Any, blocking: bool = False) -> Any:
    """Call a tool function. Async tools need the async client."""
    del blocking  # Everything runs on the calling thread here.
    result = fn(*args)
    if inspect.isawaitable(result):
        close = getattr(result, "close", None)
        if callable(close):
            close()
        raise TypeError("This tool is async; run it with AsyncTwigg")
    return result


def gather_limited(items: Sequence[T], limit: int, fn: Callable[[T], R]) -> list[R]:
    """Run one at a time, in order. Concurrency is the async client's job."""
    return [fn(item) for item in items]
