# @twigg/sdk

TypeScript client for the [Twigg API](https://twigg.ai/docs). No runtime dependencies; runs on
Node 22+, Deno, Bun and edge runtimes.

```bash
npm install @twigg/sdk
```

You do not need an SDK to use Twigg: the API is plain HTTP and there is no client-side state to
keep in sync. This package removes the fiddly parts: parsing the stream, assembling tool calls,
running the tool loop, and recovering a turn when the connection drops.

```ts
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "claude-opus-5" }); // reads TWIGG_API_KEY

const chat = await twigg.chats.open({ namespace: "acme/user-99", title: "Billing" });
const reply = await chat.send("What changed in billing?");
console.log(reply.text, reply.cost);
```

`model` on the client is the default for every turn; a chat's defaults or a single call can
override it.

The chat and its history live on Twigg, so there is nothing to store. To carry on a
conversation later, list the namespace and pick one up:

```ts
for await (const summary of twigg.chats.list({ namespace: "acme/user-99" })) {
  console.log(summary.title, summary.updated_at);
}

const chat = twigg.chat(summary); // or twigg.chat(id); the record stays on chat.data
await chat.send("Where were we?");
```

## Streaming

```ts
const stream = chat.stream("Summarise the refunds module");

for await (const event of stream) {
  if (event.event === "delta" && event.data.kind === "text") process.stdout.write(event.data.text);
}

const result = await stream.final();
```

Or with listeners:

```ts
const result = await chat
  .stream("Summarise the refunds module")
  .on("text", (delta) => process.stdout.write(delta))
  .on("toolCall", (call) => console.log("called", call.name, call.input))
  .final();
```

`result` has the joined `text` and `reasoning`, every block in order, tool calls with parsed
`input`, `pendingToolCalls`, `stopReason`, `usage` and `cost` (a decimal string; `null` until
settled).

The lower-level call is `twigg.responses.create(chatId, { model, input })`, which takes the API's
request body as is.

### Dropped connections

Dropping a connection never cancels a turn on Twigg. If the stream drops after the run started,
`final()` waits for the run to finish and rebuilds the result from the chat's history, marked
`recovered: true`. If it drops before the run was named, the SDK submits again with the same
idempotency key, which either starts the turn or names the run to recover. Turn this off with
`{ recover: false }`.

### Stopping a turn

```ts
const stream = chat.stream("Write a long essay");
setTimeout(() => stream.abort(), 5_000); // stops it on Twigg; the stream ends with stop_reason "aborted"
await stream.final();
```

`abort()` is safe to fire and forget: it does nothing if the stream never started, has
finished, or failed.

To stop reading without stopping the turn, call `stream.close()`; the turn carries on and lands in
history. Breaking out of a `for await` loop closes the stream the same way, unless `final()` is
also waiting for it. Passing a `signal` only detaches this client too; add `abortRun: true` to
stop the turn as well.

## Tools

```ts
import { tool } from "@twigg/sdk";
import { z } from "zod";

const readFile = tool({
  name: "read_file",
  description: "Read a file from the repository",
  input: z.object({ path: z.string() }),
  run: ({ path }) => fs.readFile(path, "utf8"),
});

const outcome = await chat.runTools("Summarise the billing module", { tools: [readFile] }).final();
console.log(outcome.result.text, outcome.turns.length);
```

The loop streams a turn, runs the tools it calls (up to 8 at once), submits their results, and
repeats until the model answers without calling more.

- `input` is any [Standard Schema](https://standardschema.dev) that can describe itself as JSON
  Schema (Zod 4.2+ does). Or pass a plain JSON Schema as `inputSchema`.
- Arguments are validated before `run`. Invalid arguments and thrown errors go back to the model
  as `is_error` results so it can correct itself; `onToolError: "throw"` stops instead.
- Return a string, any JSON value, or a `ToolResult` for media, error flags and trust levels.
- Tools already published to the namespace run through `handlers: { name: fn }`.
- `stopReason` is the model's, or `max_iterations`, or `unhandled_tool_calls` when the model
  called a tool you have no handler for (the calls are on `result.pendingToolCalls`).
- `idempotencyKey: "job-7"` makes a restarted loop recover turns that already ran.

## Attachments

```ts
import { media } from "@twigg/sdk";

await chat.send(["What is wrong with this chart?", await media.fromFile("chart.png")]);
```

`media.fromBytes`, `fromBase64` and `fromUrl` cover the other sources. `media.check(model, items)`
lists what a model would reject, using the limits from `twigg.models.list()`.

## Namespaces

```ts
const tenant = twigg.namespace("acme").child("user-99"); // acme/user-99

await tenant.chats.open({}, { model: "claude-opus-5" });
for await (const chat of tenant.chats.list()) console.log(chat.id);
await tenant.config.instructions.publish({ mode: "append", body: "Answer briefly." });
```

## Listing

List calls can be awaited for one page or iterated for every item:

```ts
const page = await twigg.chats.list({ namespace: "acme" });
const older = await page.nextPage();

for await (const chat of twigg.chats.list({ namespace: "acme" })) {
  // every chat in acme and beneath it, newest first
}
```

History iterates newest first from the latest page. Pass `after_ordinal` to page forwards instead,
oldest first.

## Configuration

```ts
await twigg.config.tools.publish({
  namespace: "acme",
  mode: "append",
  definitions: [readFile.definition],
});
const effective = await twigg.config.resolve({ namespace: "acme/support" });
```

`instructions`, `tools`, `budgets` and `retention` each support `publish`, `versions`, `restore`
and `withdraw`. To manage configuration as files, see [`@twigg/cli`](../cli).

## Forwarding a stream to a browser

On the server:

```ts
export async function POST(request: Request) {
  const { chatId, text } = await request.json();
  return twigg.chat(chatId, { model: "claude-opus-5" }).stream(text).toResponse();
}
```

In the browser, with no API key:

```ts
import { readForwardedStream } from "@twigg/sdk/browser";

const turn = readForwardedStream(await fetch("/api/chat", { method: "POST", body }));
turn.on("text", (_, all) => render(all));
const result = await turn.final();
```

`toReadableStream()` gives the bare stream for Hono, Express (`Readable.fromWeb`) and friends.
If the browser disconnects, the SDK stops reading; the turn still finishes on Twigg.

Only what a chat UI renders is forwarded: text, reasoning and tool-call blocks, and `done`
without its cost. Configuration warnings (which can name other namespaces and provider keys)
stay on the server, and errors carry their code with a generic message. Pass
`toResponse({}, { events: "all" })` to forward everything as received.

## Errors

Every failure is a `TwiggError` carrying the API's `status`, `code`, `message`, `hint` and
`details`. Subclasses let you catch by kind: `AuthenticationError`, `InsufficientBalanceError`,
`NotFoundError`, `ConflictError`, `IdempotencyConflictError`, `ValidationError`,
`RateLimitError`, `UpstreamError`, `ServiceUnavailableError`, `StreamError` (a failure after the
stream opened), and `ConnectionError` / `TimeoutError` for failures with no response.

## Retries and timeouts

Reads, deletes and restores retry up to twice on network errors, timeouts, 429 and 5xx, honouring
`Retry-After`. Publishes and chat creation retry only on 429, since a second attempt after a
partial failure could create a second version or chat. Turn submissions retry safely because
their idempotency key makes a duplicate harmless. Each attempt times out after 60 seconds;
streams count as dropped after 5 minutes of silence (`idleTimeout`).

```ts
const twigg = new Twigg({ maxRetries: 4, timeout: 20_000 });
await twigg.models.list({ timeout: 5_000, signal: controller.signal });
```

## Testing your code

`@twigg/sdk/testing` has a client backed by an in-memory Twigg, so tests run through the real SDK
without a network or credits:

```ts
import { MockTwigg, streamBuilder } from "@twigg/sdk/testing";

const twigg = new MockTwigg().respond(
  streamBuilder().text("Let me check.").toolCall("read_file", { path: "a.txt" }).done(),
  ({ history }) => streamBuilder().text(`Read ${history.length} parts`).done(),
);
```

Chats, history and runs behave like the real API, `disconnectAfter(n)` exercises recovery, and
`twigg.server.calls` records every request. `recordingFetch` and `replayFetch` capture real
traffic once and replay it; recordings never include headers, so keys stay out of fixtures.

## Public calls

`twigg.catalogue` and `twigg.meta` work without an API key.
