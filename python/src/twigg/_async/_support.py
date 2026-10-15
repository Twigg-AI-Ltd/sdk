"""What genuinely differs between the async and sync clients. Everything else in `_sync` is
generated from `_async` by scripts/unasync.py; this file has a hand-written sync twin."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from typing import Any, TypeVar

import httpx

T = TypeVar("T")
R = TypeVar("R")

HttpClient = httpx.AsyncClient
HttpTransport = httpx.AsyncBaseTransport
SleepFn = Callable[[float], Awaitable[None]]
Lock = asyncio.Lock


async def sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


@contextlib.asynccontextmanager
async def try_acquire(lock: Lock) -> AsyncGenerator[bool, None]:
    """Hold `lock` for the block if it is free, without waiting for it."""
    if lock.locked():
        yield False
        return
    async with lock:
        yield True


async def call_tool(fn: Callable[..., Any], *args: Any, blocking: bool = False) -> Any:
    """Call a tool function. A plain `def` (`blocking`) runs in a worker thread, so it neither
    freezes the event loop nor waits for the tools beside it."""
    if blocking:
        result = await asyncio.to_thread(fn, *args)
    else:
        result = fn(*args)
    if inspect.isawaitable(result):
        result = await result
    return result


async def gather_limited(
    items: Sequence[T], limit: int, fn: Callable[[T], Awaitable[R]]
) -> list[R]:
    """Map with at most `limit` calls in flight, keeping input order. The first failure cancels
    the calls still running (a tool in a worker thread finishes, but its result is dropped) and
    is raised once they have stopped."""
    semaphore = asyncio.Semaphore(max(limit, 1))

    async def one(item: T) -> R:
        async with semaphore:
            return await fn(item)

    tasks = [asyncio.ensure_future(one(item)) for item in items]
    if not tasks:
        return []
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return [task.result() for task in tasks]
