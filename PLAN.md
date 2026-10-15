# Twigg SDK plan

Status: draft, 2026-10-14. Source of truth for the API is
`twigg-api/backend/src/routes/openapi.json` (OpenAPI 3.1, 40 operations).

## Positioning

The API stays usable with plain HTTP, and the docs keep saying so: there is no
client-side state to keep in sync. The SDK is the fast path to adoption. It
removes the parts that are fiddly by hand (SSE parsing, tool-input assembly,
the tool loop, recovering a dropped stream) and adds config as code, which
plain HTTP cannot give you on its own.

## Goals

- Every customer operation covered, typed from the spec.
- Streaming that is pleasant raw and complete when accumulated.
- A disconnect mid-turn reads as a slower success, not an error.
- Config as code: declare instructions, tools, budgets and retention per
  namespace, review a plan, apply it from CI, roll it back.
- Zero runtime dependencies in the core TypeScript package. Runs on Node 22+
  (matching twigg-agent; Node 20 is end of life), Deno, Bun and edge runtimes.
- TypeScript first, Python second with the same surface.

## Non-goals (for now)

- A browser-direct client. It would put API keys in the frontend.
- A Vercel AI SDK provider. Twigg holds state on the server, which that
  abstraction does not model well. Stream forwarding covers the real need.
- Telemetry or OpenTelemetry hooks, until someone asks.

## Repository layout

One repo at `~/projects/sdk`, both languages, shared spec and fixtures.

```
sdk/
  PLAN.md
  spec/
    openapi.json          pinned copy of the backend snapshot
    config.v1.json        pinned copy of the config file schema
    SOURCE                twigg-api commit the copy came from
  fixtures/
    streams/*.sse         recorded SSE streams, shared by both test suites
    streams/*.json        expected accumulated result for each stream
  scripts/
    sync-spec.sh          copy the snapshot from twigg-api, record the commit
  typescript/
    package.json          pnpm workspace
    packages/
      sdk/                @twigg/sdk   (client, streaming, tools, testing)
      cli/                @twigg/cli   (`twigg` binary, config as code)
  python/                 twigg        (later; sync and async clients)
```

CI fails when `spec/openapi.json` differs from the backend snapshot on
`main`, so drift is visible the day it happens. The shared fixtures make the
two languages behave identically: both suites accumulate the same streams and
must produce the same JSON.

### Publishing

- **npm**: the `@twigg` scope is already ours (twigg-agent publishes
  `@twigg/agent` from it). Packages are `@twigg/sdk` and `@twigg/cli`, MIT,
  `publishConfig.access: public`. The CLI's binary is `twigg`, which does not
  clash with `twigg-agent`.
- **Release workflow** copies twigg-agent's: a tag push triggers publishing
  through npm trusted publishing (OIDC, `--provenance`), so no npm token is
  stored. It checks the tag against every package version and skips versions
  already on npm. Each new package needs its trusted publisher configured on
  npmjs.com before the first release.
- **Tags** are per language because the two will not release in lockstep:
  `ts-v0.1.0` publishes both TypeScript packages (versioned together),
  `py-v0.1.0` publishes the Python package.
- **PyPI**: needs a Twigg organisation (to create). Publish with PyPI trusted
  publishing from the same repo, also tokenless. The `twigg` name needs
  checking; `twigg-sdk` is the fallback.

## Type generation

Generate types only, hand-write the client.

- TypeScript: `openapi-typescript` into `src/generated/schema.ts`, re-exported
  under friendly names (`Chat`, `HistoryPart`, `ToolDefinition`, ...).
- Python: `datamodel-code-generator` into pydantic v2 models.
- Full client generators are a poor fit. The spec's unions are untagged
  `oneOf`s (no `discriminator`), nullables are `oneOf: [null, $ref]`, and
  `ResponseEvent` describes SSE framing that no generator understands.
- Model names are typed as `KnownModel | (string & {})`: autocomplete from a
  list generated from the public catalogue, with any string still accepted.

## TypeScript SDK

### Client

```ts
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({
  apiKey: process.env.TWIGG_API_KEY, // default: TWIGG_API_KEY env var
  baseURL: "https://api.twigg.ai",   // default
  timeout: 60_000,                   // per request; streams use an idle timeout
  maxRetries: 2,                     // safe methods only, see below
  fetch,                             // injectable, for tests and odd runtimes
  onWarning: (w) => console.warn(w), // config and translation warnings
});
```

Every method takes an optional last argument `{ signal, timeout, maxRetries,
headers }` for per-call overrides.

### Resources

| Namespace | Methods | Operations |
|---|---|---|
| `twigg.chats` | `create`, `get`, `list`, `delete`, `history` | createChat, getChat, listChats, deleteChat, getChatHistory |
| `twigg.responses` | `create`, `runTools`, `abort` | createResponse, abortResponse |
| `twigg.runs` | `get`, `waitForSettlement` | getRun |
| `twigg.models` | `list` | listModels |
| `twigg.namespaces` | `list` | listNamespaces |
| `twigg.usage` | `query` | queryUsage |
| `twigg.catalogue` | `list`, `get`, `markdown` | listCatalogue, getCatalogueModel, getCatalogueMarkdown (no auth) |
| `twigg.config.instructions` | `publish`, `versions`, `get`, `restore`, `withdraw` | instruction endpoints |
| `twigg.config.tools` | `publish`, `versions`, `get`, `restore`, `withdraw` | tool endpoints |
| `twigg.config.budgets` | `publish`, `active`, `versions`, `restore`, `withdraw` | budget endpoints |
| `twigg.config.retention` | `publish`, `versions`, `restore`, `withdraw` | retention endpoints |
| `twigg.config` | `resolve`, `resolveBudget`, `defaults`, `namespaces` | resolveConfiguration, resolveContextBudget, getConfigurationDefaults, listConfigurationNamespaces |
| `twigg.meta` | `discovery`, `version`, `updates` | discovery, get (version), listPublicUpdates |

The four config surfaces share one `VersionedConfigResource` base. The
differences (budgets are per model, retention has no `get` and no `mode`) are
expressed in the subclasses.

### Ergonomic layers

**Chat handle.** The common case never touches `input` arrays.

```ts
const chat = await twigg.chats.create({ namespace: "acme/user-99", title: "Billing" });
const reply = await chat.send("What changed in billing?", { model: "claude-opus-5" });
console.log(reply.text);

const again = twigg.chat(existingChatId); // handle without a request
```

**Namespace scope.** Multi-tenant apps cannot forget the scope.

```ts
const tenant = twigg.namespace("acme/user-99");
await tenant.chats.create();          // namespace filled in
for await (const c of tenant.chats.list()) { ... }
await tenant.config.resolve();
```

**Pagination.** Two cursor styles exist and both are hidden:

- Chats: `first_id` / `last_id` with `before_id` / `after_id`, newest first.
- History: `first_ordinal` / `last_ordinal` with `before_ordinal` /
  `after_ordinal`, oldest first within a page.

Every list method returns a `Page<T>` that is also an async iterable over all
items, plus `.pages()` for page-at-a-time and `.nextPage()` for manual control.
`chat.history()` defaults to walking backwards from the newest page, since that
is what a UI loading a transcript wants; `{ direction: "forward", after }`
covers "what arrived since".

### Streaming

`twigg.responses.create()` returns a `ResponseStream` immediately and
connects lazily.

```ts
const stream = twigg.responses.create(chat.id, {
  model: "claude-opus-5",
  input: [{ type: "prompt", text: "What changed in billing?" }],
});

for await (const ev of stream) {          // typed union on ev.event
  if (ev.event === "delta" && ev.data.kind === "text") process.stdout.write(ev.data.text);
}

const result = await stream.final();
```

Convenience event hooks for people who prefer callbacks:
`stream.on("text", fn)`, `"reasoning"`, `"toolCall"`, `"warning"`,
`"compacting"`, `"done"`, `"error"`.

`stream.runId` is a promise that resolves on the `run` event. It is the key
for recovery and for `abort`.

**Accumulation.** `block_stop` carries no payload, so the accumulator tracks
the open block from `block_start`. It concatenates `tool_input` deltas per
`tool_use_id` and parses the JSON at block stop. A parse failure is reported
on the tool call (`inputError`), not thrown, because the model produced it.

```ts
interface ResponseResult {
  runId: string;
  chatId: string;
  text: string;                 // all text blocks joined
  reasoning: string;
  refusal: string | null;
  blocks: Block[];              // ordered: text | reasoning | refusal | tool_call
  toolCalls: ToolCall[];        // { id, name, input, rawInput, inputError? }
  pendingToolCalls: PendingCall[];
  closedToolCalls: string[];
  stopReason: StopReason;
  usage: Usage;
  cost: Money | null;           // null while settlement is pending
  costCurrency: string;
  modelServed: string | null;
  compaction: Compaction | null;
  warnings: Warning[];
  recovered: boolean;           // true when built from run + history after a drop
}
```

`Money` stays a decimal string in TypeScript, with an optional `toNumber()`
helper documented as lossy. Python uses `Decimal`.

**Recovery.** Dropping the connection does not cancel the turn, and reusing
an idempotency key returns 409 without replaying the stream. So:

1. Every `create` sends an idempotency key, generated if the caller gave none.
2. If the connection drops after the `run` event, `final()` switches to
   recovery. It polls `runs.get(runId)` with backoff until the run is terminal,
   then reads history after the last ordinal known before the turn, and builds
   the same `ResponseResult` with `recovered: true`.
3. If the connection drops before the `run` event, the outcome is unknown. The
   SDK resubmits once with the **same** key. A 409 then names the original
   run, and step 2 takes over. A 2xx means the first attempt never landed.
4. Iterating a recovered stream yields the events that arrived live and then a
   synthetic `recovered` event, so a UI can redraw from the result.

Recovery is on by default and can be disabled with `{ recover: false }`.

**Cancellation.** `signal` detaches the client. `{ abortRun: true }` also
calls `POST /abort` so the turn stops on the server. `stream.abort()` does
both.

**Retry of a failed run.** `twigg.responses.retry(chat.id, runId, { model,
tools })` sends `input: []`, `retry_of` and a new idempotency key, as the API
requires.

### Tool loop

```ts
import { tool } from "@twigg/sdk";
import { z } from "zod";

const readFile = tool({
  name: "read_file",
  description: "Read a file from the repo",
  input: z.object({ path: z.string() }),
  run: async ({ path }) => fs.readFile(path, "utf8"),
});

const result = await twigg.responses.runTools(chat.id, {
  model: "claude-opus-5",
  input: [{ type: "prompt", text: "Summarise the billing module" }],
  tools: [readFile],
  maxIterations: 20,
  onToolCall: (call) => log(call),
});
```

- `tool()` accepts a Zod schema (converted to JSON Schema) or a raw JSON
  Schema with a typed `run`. Zod is a peer dependency, only needed if used.
- The model's input is validated before `run` is called. A validation failure
  goes back to the model as `is_error: true` with the issues as text.
- A tool that throws goes back to the model as `is_error: true` with the error
  message. `{ onToolError: "throw" }` stops the loop and rethrows instead,
  for development.
- A tool can return a string, an object (JSON-encoded), or
  `{ text, media, isError, trust }` for full control.
- Tools may be request-level (sent with each turn) or already published to the
  namespace. Handlers for published tools are matched by name, and a pending
  call with no handler stops the loop and returns, so the caller can answer it.
- Parallel calls in one turn run concurrently, capped by `toolConcurrency`.
- The loop yields events too: `for await (const ev of twigg.responses.runTools(...))`
  sees every turn's stream plus `tool_result` events it submitted.

### Media

```ts
import { media } from "@twigg/sdk";

await chat.send([
  "What is wrong with this chart?",
  await media.fromFile("chart.png"),        // Node; reads, base64s, sniffs MIME
  media.fromBytes(bytes, "application/pdf", "report.pdf"),
]);
```

Optional `{ validateAgainst: "claude-opus-5" }` checks the model's media
capabilities from the catalogue before submitting, giving a local error
instead of a 422.

History helpers: `part.toSubmittable()` turns a stored prompt or tool result
(fetched with `include: "full"`) back into an input part.

### Errors

All errors extend `TwiggError` with `status`, `code`, `message`, `hint`,
`details`, `requestId` when available, and `runId` for in-stream errors.

| Class | When |
|---|---|
| `AuthenticationError` | 401 |
| `InsufficientBalanceError` | 402 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `IdempotencyConflictError` | 409 on key reuse, carries `originalRunId` |
| `PayloadTooLargeError` | 413 |
| `ValidationError` | 400, 422 |
| `UpstreamError` | 502, and in-stream provider failures, carries `kind: LlmErrorKind` |
| `ServiceUnavailableError` | 503 |
| `ConnectionError` | network failure, no response |
| `StreamError` | `error` event after the stream opened |

### Retries

- GET, DELETE, `/activate` and `/active` withdrawals retry on network errors,
  502 and 503 with exponential backoff and jitter. They are idempotent by
  construction.
- `publish*` and `chats.create` do not retry automatically. They are not
  idempotent today (see backend asks).
- `responses.create` never retries blindly; it uses the recovery path above.

### Web glue

```ts
// Next.js route handler
export async function POST(req: Request) {
  const { chatId, text } = await req.json();
  const stream = twigg.responses.create(chatId, { model, input: [{ type: "prompt", text }] });
  return stream.toResponse(); // re-emits SSE to the browser, key never leaves the server
}
```

- `stream.toReadableStream()` for Hono, Express (via `Readable.fromWeb`) and
  friends.
- `@twigg/sdk/browser`: a small parser for that forwarded stream with the same
  accumulator, so the browser gets `text`, `toolCalls` and `done` without
  reimplementing it. No API key, no requests of its own.

### Testing support

`@twigg/sdk/testing`:

- `MockTwigg`: same surface, in memory. Chats, history and runs behave
  plausibly; responses are scripted.
- `streamBuilder()`: build SSE streams fluently
  (`.text("Hi").toolCall("read_file", { path: "a" }).done({ stopReason: "tool_use" })`).
- `recordTo(dir)` / `replayFrom(dir)`: capture real streams to fixtures and
  replay them in tests.

The shared `fixtures/streams` folder doubles as the SDK's own conformance
suite.

## Config as code

### The file

`twigg.config.ts` (typed, with autocomplete) or `twigg.config.yaml` /
`.json`, all first class. `global` is the org-wide scope and `namespaces`
holds the rest. They are separate keys because `global` is itself a valid
namespace name. Text can be inline or loaded from a file, so long
instructions live in Markdown next to the code.

```ts
import { defineConfig, file } from "@twigg/cli";

export default defineConfig({
  version: 1,
  global: {
    instructions: file("prompts/global.md"),
    retention: file("policies/retention.json"),
  },
  namespaces: {
    acme: {
      instructions: { mode: "append", body: file("prompts/acme.md") },
      tools: { mode: "append", definitions: [readFile, searchDocs] },
      budgets: {
        default: { version: 3, headroom: 0.2, history_mode: "summarize" },
        "claude-opus-5": { version: 3, headroom: 0.15, max_history_tokens: 200_000 },
      },
    },
    "acme/support": {
      instructions: { mode: "replace", body: file("prompts/support.md") },
      tools: null, // withdraw: inherit acme's tools
    },
  },
});
```

Tool definitions can be the same `tool()` objects the runtime uses, so the
schema the agent runs with and the schema published to Twigg cannot drift.
Budget keys are `default` or catalogue names; the CLI resolves names to model
UUIDs. Budgets and retention are the API's own documents, unchanged,
including their document `version` fields.

The same config in YAML:

```yaml
# yaml-language-server: $schema=https://twigg.ai/schemas/config.v1.json
version: 1
global:
  instructions: { $file: prompts/global.md }
  retention: { $file: policies/retention.json }
namespaces:
  acme:
    instructions:
      mode: append
      body: { $file: prompts/acme.md }
    tools:
      mode: append
      definitions:
        - $file: tools/read_file.json
        - name: search_docs
          description: Search the product docs
          input_schema:
            type: object
            properties: { query: { type: string } }
            required: [query]
    budgets:
      default: { version: 3, headroom: 0.2, history_mode: summarize }
      claude-opus-5: { version: 3, headroom: 0.15, max_history_tokens: 200000 }
  acme/support:
    instructions:
      mode: replace
      body: { $file: prompts/support.md }
    tools: null
```

- A bare string or `$file` for instructions publishes with mode `append`;
  `mode` defaults to `append` for tools too.
- `$file` works for instruction bodies (Markdown or text), tool definitions,
  budgets and retention (JSON or YAML). Paths are relative to the config file.
- `${TWIGG_VAR_NAME}` interpolation inside strings (only `TWIGG_VAR_*`, so secrets such as
  `TWIGG_API_KEY` cannot reach plan output or published config), so one file can target staging
  and production. Numbers and booleans cannot be interpolated, because the
  schema validates the file as written.
- `version: 1` at the top so the format can evolve.
- The YAML parser is a dependency of `@twigg/cli` only; the core SDK stays
  dependency free.
- `twigg config pull --format yaml|ts` chooses the output format, and
  `twigg config convert` translates between them (TS to YAML only when the
  tools are plain data).

### The file's JSON Schema

Generated in **twigg-api**, next to the OpenAPI snapshot, and served by the
website at `https://twigg.ai/schemas/config.v1.json`.

- The envelope (`global`, `namespaces`, `$file`, scope shapes, `null` as
  withdraw) is authored in `frontend/content/config-schema.json`.
- `frontend/scripts/build-config-schema.mjs` copies the surface schemas
  (`ToolDefinition`, `ContextBudget`, `RetentionRules`, `ConfigMode`,
  `Namespace` and everything they reference) out of `openapi.json` into
  `$defs`, and writes `frontend/public/schemas/config.v1.json`. It runs in
  `docs:generate` and `docs:check`, like the rest of the public reference.
- Tests validate the backend's own platform defaults as config values, so the
  file format cannot drift from what publish accepts.
- The SDK repo syncs `config.v1.json` alongside `openapi.json`
  (`spec/config.v1.json`), ships it inside `@twigg/cli` for offline use, and
  generates the `defineConfig` types from it. TS and YAML validate alike.
- The URL stays `v1` while changes are additive.
- Register the URL with SchemaStore for `twigg.config.yaml` / `.json`, so VS
  Code and JetBrains validate the file with no `$schema` comment.

### Managed versus unmanaged

A scope or surface absent from the file is **unmanaged**, and the CLI leaves
it alone. Declaring `tools: null` means "managed, and there should be no
override here", which plans a withdraw. This keeps a partial adoption safe:
pointing the CLI at a file that only knows about `acme` never touches `global`.

`--prune` opt-in: treat every scope the org has config for, but the file does
not mention, as `null`.

### Scopes and the subtree

The version-listing endpoints return the exact namespace only. Resolution,
though, walks the whole chain: a `replace` at `acme/support` cuts off whatever
`acme` declares, and an `append` beneath adds to it. So a plan for one scope
also has to look underneath it.

- `--scope acme` means `acme` **and every namespace beneath it**. The CLI
  finds the descendants with `GET /api/v1/config/namespaces`, then lists
  versions for each one individually.
- Descendants the file declares are planned as normal.
- Descendants the file does not declare but that have overrides are shown as
  unmanaged, with what they override, so a reviewer sees that changing `acme`
  will not reach `acme/support` because it uses `replace`:

  ```
  acme/support   (unmanaged)  instructions: replace v2, shadows acme
  ```

  `--prune` withdraws them.
- `pull --scope acme` pulls the subtree too.
- Applying runs parents before children.

### Commands

```
twigg config pull   [--scope acme] [--out twigg.config.ts]
twigg config plan   [-c twigg.config.ts] [--scope acme] [--json]
twigg config apply  [-c ...] [--scope ...] [--yes] [--prune]
twigg config rollback --scope acme --surface tools [--to <version>]
twigg config resolve --scope acme/support      # effective config after inheritance
twigg config history --scope acme [--surface instructions]
```

- **pull** writes the current active config as a file, with instructions and
  long bodies split into `prompts/*.md`. This is the onboarding path for an
  org that already configured things in the console.
- **plan** fetches active versions (bodies via `getInstructions` and
  `getTools`, budgets and retention from their list endpoints), normalises
  both sides, and prints a diff per scope and surface:

  ```
  acme
    ~ instructions  v3 -> v4   (+12 lines, -3 lines)   ~410 tokens
    + tools         read_file, search_docs              ~620 tokens
    = budgets       unchanged
  acme/support
    - tools         withdraw override (inherits from acme)
  Plan: 2 to publish, 1 to withdraw, 3 unchanged.
  ```

  It also prints the resolved token estimate per touched namespace, since that
  is what the context budget will be charged.
- **apply** shows the plan, asks for confirmation unless `--yes`, then publishes
  in dependency order (parents before children). Each step's new version id
  is printed and written to a state-free report (`--report apply.json`) so CI
  can attach it.
- **rollback** restores the previous version (or `--to`) via the `/activate`
  endpoints. No new version is created, matching the API's restore semantics.
- **history** lists versions with the active one marked.

Exit codes for CI: `0` success and `1` error for every command, so a successful apply never
fails a CI step. `plan --detailed-exitcode` exits `2` when there are changes, as Terraform's does,
so a scheduled check can fail on unapplied drift. Org-wide pruning takes `--prune-all`; `--prune`
needs `--scope`.

### Normalisation rules

Plans must not flap, so both sides are normalised before diffing:

- Instruction bodies: line endings to `\n`, trailing whitespace at end of file
  trimmed. Nothing else; whitespace inside a prompt is meaning.
- Tool definitions: sorted by name, JSON Schema keys canonicalised, `strict`
  absent and `strict: null` treated as equal.
- Budgets and retention: compared as canonical JSON after filling defaults
  from `GET /config/defaults`, so omitting a default field is not a change.
- `mode` differences are changes.

### Safety

- No state file. The API's versions are the state, which avoids a whole class
  of Terraform problems.
- Concurrent applies or console edits can race (publish has no precondition).
  The CLI re-reads active versions immediately before each publish and aborts
  if they changed since the plan. The backend ask below closes the remaining
  window.
- API key from `TWIGG_API_KEY`; a `--profile` lookup in
  `~/.config/twigg/credentials` for people juggling orgs.

### CI recipe

Ship a documented GitHub Actions example: `plan` on pull requests (posting the
plan as a comment), `apply --yes` on merge to main.

## Python SDK

Same resources and names, Python idioms:

- `Twigg` and `AsyncTwigg`, built on `httpx`.
- pydantic v2 models generated from the spec.
- `with twigg.responses.stream(...) as stream:` iterating events,
  `stream.final()` for the result.
- `@tool` decorator deriving the schema from type hints or a pydantic model.
- `Decimal` for money.
- Same conformance fixtures as the TypeScript suite.

The CLI stays TypeScript only. Python users get it with `npx @twigg/cli`.

## Backend asks

None block the SDK. Each makes it less fragile.

1. **`details.run_id` on the idempotency 409.** Today the run is named only in
   the message text, and the recovery path depends on it.
2. **`discriminator` mappings in the generated spec.** utoipa can emit them.
   Cleaner generated unions in both languages.
3. **`Retry-After` on 503**, and on any future rate limiting.
4. **Optimistic concurrency on config publish**, for example an optional
   `expected_active_version`. Makes `config apply` race-free.
5. **Idempotency keys on `createChat` and config publish**, so they can be
   retried safely.
6. **Request id header** on every response, surfaced in `TwiggError`.
7. Later: **`Last-Event-ID` stream resumption**, turning recovery from
   "rebuild from history" into a true resume.

## Milestones

### Progress

- **Milestone 1 done (2026-10-14).** `typescript/packages/sdk`: transport (auth, per-attempt
  timeouts, retries by idempotency, Retry-After), the error family, pagination, and every
  operation except `createResponse`. 74 tests, including a contract test that fails when the
  spec gains an operation the SDK does not cover or a path drifts. Public calls smoke-tested
  against production; authenticated calls not yet run live.
- Decisions made while building:
  - Request bodies and query parameters keep the API's snake_case wire names, so the types
    stay generated rather than translated. SDK-only options (`signal`, `timeout`) are camelCase.
  - List calls return a lazy `PagePromise`: awaited it is one page, iterated it is every item.
    Iteration follows the paging direction (history newest first by default; `after_ordinal`
    pages forward, oldest first).
  - `namespaces.list()` returns a page although the endpoint does not paginate yet.
  - `delete`, `restore` and `withdraw` count as idempotent and retry on 5xx; publishes and
    `chats.create` retry only on 429.
- **Milestones 2, 3, 4 and 6 done (2026-10-14).**
  - Streaming: `ResponseStream` (lazy, buffered for any number of consumers, typed listeners,
    `abort()` that stops the run server-side, idle timeout, retry of a failed run). Recovery:
    a drop after the `run` event polls the run then rebuilds the turn from history; a drop
    before it resubmits with the same idempotency key and recovers from the 409. Recovered
    results infer `stopReason` and lack `providerResponseId`, `compaction` and `serverTools`.
  - The four streams twigg-agent recorded against production are the shared conformance
    fixtures in `fixtures/streams/`, with expected results in a language-neutral shape.
  - Tools: `tool()` takes any Standard Schema with `~standard.jsonSchema` (Zod 4.2+) or plain
    JSON Schema. `runTools` with handlers for published tools, concurrency, `onToolError`, a
    per-turn idempotency key prefix, and stop reasons `max_iterations` and
    `unhandled_tool_calls` (any call without a handler stops the loop before running others).
  - Chat handles (`chats.open`, `twigg.chat`), `twigg.namespace(...).child(...)`, media helpers
    with a local check against catalogue limits, `toSubmittable`, `runs.waitForSettlement`.
  - `@twigg/sdk/testing`: `MockTwigg` (in-memory chats, history, runs and scripted turns,
    `disconnectAfter` for recovery), `streamBuilder`, `recordingFetch` / `replayFetch`.
  - `@twigg/sdk/browser`: `readForwardedStream` for streams forwarded with `toResponse()`.
- **Milestone 5 done (2026-10-14).** `@twigg/cli` with `config plan|apply|pull|rollback|resolve|
  history|validate|convert`. TS configs load through jiti (Node's type stripping is unflagged
  only from 22.18 and refuses TS in node_modules). YAML/JSON validate against the shipped copy
  of `config.v1.json` (a test keeps it identical to `spec/`), and validation errors are trimmed
  to one line per mistake. Decisions taken while building:
  - A scope's `budgets` map is its whole set: an active budget for an unlisted model is
    withdrawn. `null` withdraws all of them.
  - `--prune` only touches scopes the file does not mention; an omitted surface inside a
    mentioned scope stays unmanaged.
  - `--scope X` means X and beneath for plan/apply/pull; no scope means everything. For
    rollback/resolve/history no scope means the organisation-wide scope.
  - Token figures in the plan are local estimates for new content (characters / 4).
  - `apply` stops at the first change that drifted since the plan and reports what it already
    applied (`--report`), rather than re-planning.
- **Milestone 7 done (2026-10-14).** `python/`: `Twigg` and `AsyncTwigg` on httpx, pydantic v2
  models generated with datamodel-codegen, and the sync client generated from the async one
  (`scripts/unasync.py`) so they cannot drift. Same transport rules, errors, pagination,
  streaming with recovery, tool loop (`@tool` from pydantic models or type hints), chat
  handles, namespace scope and media helpers; it passes the shared stream fixtures. 141 tests,
  ruff, pyright strict, on Python 3.10 and 3.12. Differences from TypeScript: async list calls
  are awaited for the first page; iteration helpers (`text_stream`, `tool_calls`) instead
  of listeners; the sync tool loop runs tools one at a time; no `abort_run` signal option; no
  MockTwigg/test kit yet; `Decimal` money on results.
- **Code review (2026-10-14).** An independent review of the TS streaming and tool code found
  six bugs and two risks: recovery could return a later turn's output, a restarted tool loop
  could re-run tools, a throwing listener looked like a dropped connection, a leaked connect
  timer could hold a script open for 60s, `runId`-only use could leave an unhandled rejection,
  `abort()` could send two requests. All fixed in both SDKs with regression tests.
- **Milestone 8 partly done.** READMEs for every package. Not done: SDK pages on twigg.ai/docs
  and an SDK section in `llms.txt` (both are twigg-api changes, left for a separate pass).
- Not started: release workflow (copy twigg-agent's, with `ts-v*` / `py-v*` tags and trusted
  publishers configured on npm and PyPI), a remote for this repo.
- **Live-tested against production (2026-10-14)**, with `gpt-6-luna` in throwaway
  `sdk-test/*` namespaces (chats deleted, config withdrawn afterwards). TypeScript 12/12: reads,
  send, streaming, history both ways (`after_ordinal: -1` does read from the start), settlement,
  the tool loop, recovery after a simulated drop, idempotency replay, server-side abort, config
  publish/resolve/withdraw, error mapping. Python 7/7: the same core, sync and async. CLI:
  plan, apply, re-plan, rollback, pull, withdraw-all. Withdrawing a scope's default budget
  leaves per-model budgets alone, as the CLI assumes.
- Found live and fixed: Twigg stores budget and retention fractions as 32-bit floats
  (`0.15` reads back as `0.15000000596046448`), which made every budget plan show a change. The
  CLI now reads stored fractions as the shortest decimal with the same 32-bit value.


1. **Foundations.** Repo, spec sync, type generation, client, errors, retries,
   pagination, every non-streaming resource. Tests against a mocked fetch.
2. **Streaming.** SSE parser, accumulator, recovery, abort, retry, shared
   fixtures. Tests against recorded staging streams.
3. **Tools and ergonomics.** `tool()`, `runTools`, chat handle, namespace
   scope, media helpers, warnings hook. Release `@twigg/sdk` 0.1.
4. **Testing kit.** `MockTwigg`, stream builder, record and replay.
5. **Config as code.** `@twigg/cli` with pull, plan, apply, rollback,
   resolve, history. CI recipe. Release 0.1 of the CLI.
6. **Web glue.** `toResponse`, `toReadableStream`, browser parser.
7. **Python.** Port milestones 1 to 4 against the same fixtures.
8. **Docs.** SDK pages on twigg.ai/docs next to the plain HTTP examples, and an
   SDK section in `llms.txt`.

## Open questions

- PyPI: create the Twigg organisation, then check whether `twigg` is free.
- Whether discovery (`GET /`) should link the config schema next to
  `openapi` and `llms_txt`.

## Out of scope for now

- Moving the docs example app (`twigg-chat`) onto the SDK. That comes after
  the SDK ships.
