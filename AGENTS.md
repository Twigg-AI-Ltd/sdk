# Working on the Twigg SDKs

Client libraries for the Twigg API: `@twigg/sdk` and `@twigg/cli` (TypeScript, in `typescript/`)
and `twigg` (Python, in `python/`). `PLAN.md` holds the design and the decisions behind it; read
the relevant part before changing behaviour.

## Checks

Run both before you finish. CI runs the same on Node 22 and 24 and Python 3.10, 3.12 and 3.13.

```bash
cd typescript && pnpm install && pnpm check && pnpm build   # tsc, biome, vitest
cd python && uv sync && uv run ruff check . && uv run ruff format --check . \
  && uv run pyright && uv run pytest && uv run python scripts/unasync.py --check
```

`pnpm format` fixes formatting; `uv run ruff format .` likewise.

## Rules

- **Generated code is never edited by hand.**
  - `typescript/packages/sdk/src/generated/schema.ts`: `pnpm --dir typescript/packages/sdk gen:types`.
  - `python/src/twigg/_generated/models.py`: `cd python && ./scripts/generate_models.sh`.
  - Both come from `spec/openapi.json`, which `node scripts/sync-spec.mjs` copies from twigg-api.
    `--check` compares it with the live API.
- **Python's sync client is generated from the async one.** Edit `python/src/twigg/_async/`, then
  run `uv run python scripts/unasync.py`. `_support.py` is the exception: it is hand-written on
  both sides.
- **Both languages behave the same.** A behaviour change in one needs the same change in the
  other, and the shared stream fixtures in `fixtures/streams/` must still pass in both.
- **Wire names stay snake_case.** Request bodies and query parameters use the API's own field
  names so the types stay generated; only SDK-only options (`signal`, `timeout`, `maxRetries`)
  follow the language's convention.
- **Forward compatible.** A new event, block kind, enum value or field from the API must never
  crash a client. Unknown things are passed through or kept as an unknown variant.
- **Every fix gets a regression test.** Review findings live in `test/review-regressions.test.ts`
  and `tests/test_review_regressions.py`.
- **The public surface follows the OpenAI/Anthropic SDK conventions** (`baseURL`, `maxRetries`,
  `finalResponse()`, `text_stream`, `APIConnectionError`) so it feels familiar. Keep it that way.
- **No live API calls in tests.** Use the fake APIs in the test helpers or `MockTwigg`.
- **README code blocks wrapped in `<!-- docs:name -->` markers are published on twigg.ai.**
  twigg-api's `frontend/scripts/build-sdks.mjs` extracts them at a pinned commit for the docs
  and the landing page. Keep the markers and names when editing; a renamed or missing block
  fails that build.

## Layout

```
spec/               pinned OpenAPI and config schema, and the twigg-api commit they came from
fixtures/streams/   recorded production streams and the result each must accumulate to
typescript/packages/sdk   @twigg/sdk: client, streaming, tools, testing, browser
typescript/packages/cli   @twigg/cli: `twigg config ...`
python/             twigg: Twigg and AsyncTwigg
examples/           one idea per script, same numbering in both languages
```

## Releasing

See `RELEASING.md`. In short: push a tag; `ts-v0.2.0` publishes both npm packages and
`py-v0.2.0` publishes to PyPI. The tag must match every declared version.
