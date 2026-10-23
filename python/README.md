# twigg

Python client for the [Twigg API](https://twigg.ai/docs). Sync and async, fully typed, built on
`httpx` and `pydantic`. Python 3.10+.

<!-- docs:install -->
```bash
pip install twigg
```
<!-- /docs:install -->

<!-- docs:quickstart -->
```python
from twigg import Twigg

twigg = Twigg(model="claude-opus-5")  # reads TWIGG_API_KEY

chat = twigg.chats.open(namespace="acme/user-99", title="Billing")
reply = chat.send("What changed in billing?")
print(reply.text)
```
<!-- /docs:quickstart -->

`model` on the client is the default for every turn; a chat's defaults or a single call can
override it. `system` adds a system prompt to one request, after the instructions configured for
the namespace; it is not stored, so pass it with every turn it should apply to (or in the chat's
defaults).

The chat and its history live on Twigg, so there is nothing to store. To carry on a
conversation later, list the namespace and pick one up:

```python
for summary in twigg.chats.list(namespace="acme/user-99"):  # newest first, every page
    print(summary.title, summary.updated_at)

latest = twigg.chats.list(namespace="acme/user-99", limit=1).data[0]
chat = twigg.chat(latest)  # or twigg.chat(chat_id); the record stays on chat.data
chat.send("Where were we?")
```

Every method has an async twin on `AsyncTwigg`:

```python
from twigg import AsyncTwigg

async with AsyncTwigg() as twigg:
    page = await twigg.chats.list(namespace="acme")
    async for chat in page:
        print(chat.id)
```

## Quick reference

<!-- docs:reference -->
```python
from twigg import Twigg, tool

twigg = Twigg(model="gpt-6-luna")  # key from TWIGG_API_KEY
models = twigg.models.list()  # names to pass as `model`

chat = twigg.chats.open(namespace="acme/user-99")  # new chat
again = twigg.chat(chat_id)  # existing chat, no request
by_phone = twigg.chat_by_external_id("+447700900123")  # your own id; made on first send

reply = chat.send("Hi")  # .text .cost .usage .tool_calls .stop_reason
with chat.stream("Hi") as stream:
    for text in stream.text_stream:
        print(text, end="")
outcome = chat.run_tools("Hi", tools=[my_tool]).final()  # the tool loop

chats = list(twigg.chats.list(namespace="acme"))  # every chat, newest first
transcript = list(chat.history(after_ordinal=-1))  # oldest first

acme = twigg.namespace("acme")  # pins the namespace
acme.config.instructions.publish(mode="append", body="Answer briefly.")
run = twigg.runs.wait_for_settlement(reply.run_id)  # the final cost
```
<!-- /docs:reference -->

`AsyncTwigg` has the same methods, awaited. Every failure is a `TwiggError`. Runnable versions of
all of this are in [examples/](https://github.com/Twigg-AI-Ltd/sdk/tree/main/examples).

## Chats by your own id

Give a chat your own identifier, such as the sender's phone number or another system's
conversation id, and address it by that instead of Twigg's chat id. There is then no mapping to
store: the first message creates the chat, and every later one lands in the same chat.

```python
chat = twigg.chat_by_external_id(f"whatsapp:{sender}", chat={"namespace": "support"})
reply = chat.send(text)  # one request, whether or not the chat existed
```

Every call on the handle (`send`, `stream`, `run_tools`, `retry`, `history`, `get`, `delete`,
`abort`) goes to the external-id routes, recovery after a dropped connection included. `chat`
describes the chat to create; on an existing chat it is ignored, except that a different
`namespace` is refused with 409 `external_id_namespace_mismatch`. External ids are unique per
organisation, so prefix them (`whatsapp:`, `sms:`) to keep separate channels apart.

`twigg.chats.open_by_external_id(id)` creates or fetches the chat and returns an ordinary `Chat`
with its Twigg id. `get_by_external_id`, `delete_by_external_id` and `history_by_external_id` are
on `twigg.chats`; `stream_by_external_id`, `run_tools_by_external_id` and `abort_by_external_id`
are on `twigg.responses`. `chats.create(external_id=...)` sets one on a new chat, and is refused
with 409 `external_id_taken` when another chat holds it.

An external id travels in URL paths, so it appears in request logs. If it identifies a person and
that matters to you, use a hash or another opaque value instead.

When tools run somewhere else, as in an automation workflow, a second message can arrive while a
tool is still running. Pass `wait_for_pending_tool_calls=60` and that message is refused with 409
`tool_calls_pending` and a `Retry-After` header, instead of closing the open tool calls.

### Bringing a conversation over

To move a conversation that started elsewhere, import it as the chat's history before its first
message. No model is called; the chat's first turn compacts the history if it needs to.

```python
chat = twigg.chat_by_external_id(f"whatsapp:{sender}", chat={"namespace": "support"})
imported = chat.import_history(
    [
        {"type": "prompt", "text": "Where is my order?"},
        {"type": "tool_call", "tool_use_id": "c1", "name": "track", "arguments": {"order": 7}},
        {"type": "tool_result", "tool_use_id": "c1", "tool_name": "track", "text": "Shipped"},
        {"type": "message", "text": "It shipped this morning."},
    ]
)
if isinstance(imported, ImportSkippedResponse):  # from twigg.types
    print(f"already had {imported.existing_parts} parts")
else:
    for warning in imported.warnings:
        print(warning.code, warning.message)
```

Only an empty chat is written to: a chat with history answers `skipped=True` and nothing is
stored or charged, so retrying is safe. The API repairs the parts into a valid conversation
(results that answer no call are dropped, calls with no result are closed, tool names are made
provider-safe) and lists every change in `warnings`. `arguments` may also be a string holding a
JSON object. At most 500 parts per import, charged per million estimated tokens stored;
`twigg.chats.import_by_external_id(id, parts, chat=...)` does the same without a handle. A turn
running on the chat makes it 409 `chat_busy`.

## Streaming

```python
with twigg.responses.stream(
    chat.id, model="claude-opus-5", input=[{"type": "prompt", "text": "Hi"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    result = stream.final()
```

Iterating a stream yields typed events (`RunEvent`, `DeltaEvent`, `BlockStopEvent`,
`DoneEvent`, ...); `stream.tool_calls` yields each tool call once its arguments have arrived;
`stream.run_id` names the run as soon as the stream does.

Each submission carries an idempotency key, generated when absent. If the connection drops, the
turn carries on server-side and `final()` rebuilds its result from the run and chat history
(`result.recovered` is then true). `stream.abort()` stops the turn on the server.

`stream.close()` closes the connection without stopping the turn, and is safe to call from
another thread or task while the stream is being read, as a cancel button would. Leaving a
`for` loop early keeps the connection open so `final()` still works; use the stream (or a tool
runner) as a context manager to close it when the block ends.

## Tools

<!-- docs:tools -->
```python
from twigg import tool


@tool
def read_file(path: str) -> str:
    """Read a file from the repo."""
    return open(path).read()


outcome = chat.run_tools("Summarise the billing module", tools=[read_file]).final()
print(outcome.stop_reason, outcome.result.text)
```
<!-- /docs:tools -->

The input schema comes from the type hints, or from a single pydantic model parameter. Input is
validated before the function runs; invalid input and raised exceptions go back to the model as
error results so it can correct itself (`on_tool_error="throw"` raises instead). Return a string,
any JSON value, or `ToolResult` for media, an error flag or a trust level. Declare a parameter
annotated `ToolContext` to see the call. `handlers={"name": fn}` answers tools already published
to the namespace. `idempotency_key="job-7"` makes a restarted loop recover turns that already
ran; turns are submitted as `job-7-0`, `job-7-1`, ..., and keys may use letters, digits and
`-._~`. On `AsyncTwigg` a turn's tools run concurrently: `async def` tools on the event
loop, plain `def` tools in worker threads so they never block it. With `on_tool_error="throw"`,
the first failure cancels the tools still running beside it.

## Listing

Pages iterate over every item, fetching more as needed, in the paging direction:

```python
for chat in twigg.chats.list(namespace="acme"):
    ...  # newest first, everything in acme and beneath it

page = twigg.chats.history(chat_id)
older = page.next_page()
```

History iterates newest first from the latest page. Pass `after_ordinal` to page forwards
instead, oldest first; `after_ordinal=-1` reads a whole transcript from the start.

## Namespaces and configuration

```python
acme = twigg.namespace("acme")
acme.config.instructions.publish(body="Answer as Acme's billing assistant.")
support = acme.child("support")
effective = support.config.resolve()
```

`instructions`, `tools`, `budgets` and `retention` each support `publish`, `versions`,
`restore` and `withdraw`.

## Errors

Every failure is a `TwiggError` carrying the API's `status`, `code`, `message`, `hint` and
`details`. Subclasses let you catch by kind (`NotFoundError`, `InsufficientBalanceError`,
`ValidationError`, `IdempotencyConflictError`, `StreamError`, ...). `APIConnectionError` and
`APITimeoutError` cover failures with no response; `APITimeoutError` is also a built-in
`TimeoutError`. A response the SDK cannot read raises `TwiggError` with
`code="invalid_response"`.

A chat already running a turn raises `ConflictError` with `code` `"chat_busy"`; wait
`details["retry_after_secs"]` seconds (also sent as `Retry-After`) and send again.

## Forward compatibility

Values the API adds after this release do not break calls that work today. An enum field accepts
strings it does not list; a history part of a new type arrives as `UnknownHistoryBody` with all
its fields; a stream block of a new kind becomes an `UnknownBlock`, kept out of `result.text`.

## Retries and timeouts

Reads, deletes and restores retry up to twice on network errors, timeouts, 429 and 5xx,
honouring `Retry-After`. Publishes and chat creation retry only on 429. Each attempt times out
after 60 seconds.

```python
from twigg import RequestOptions, Twigg

twigg = Twigg(max_retries=4, timeout=20)
twigg.models.list(options=RequestOptions(timeout=5))
```

## Media

```python
from twigg import media

chat.send(["What is wrong with this chart?", media.from_file("chart.png")])
model = next(m for m in twigg.models.list() if m.name == "claude-opus-5")
problems = media.check(model, [media.from_file("scan.pdf")])
```

## Developing

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run pyright
./scripts/generate_models.sh       # after node ../scripts/sync-spec.mjs
uv run python scripts/unasync.py   # after editing src/twigg/_async
```

The sync client in `src/twigg/_sync` is generated from the async source in `src/twigg/_async`;
edit the async code and regenerate. `_support.py` is hand-written in both.
