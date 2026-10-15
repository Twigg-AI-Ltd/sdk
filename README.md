# Twigg SDKs

Client libraries for the [Twigg API](https://twigg.ai/docs).

| Package | What | Source |
|---|---|---|
| `@twigg/sdk` | TypeScript client: streaming, tool loop, recovery, test kit | [`typescript/packages/sdk`](typescript/packages/sdk) |
| `@twigg/cli` | `twigg config plan/apply`: Twigg configuration as code, in YAML or TypeScript | [`typescript/packages/cli`](typescript/packages/cli) |
| `twigg` (PyPI) | Python client, sync and async | [`python`](python) |

You do not need an SDK to use Twigg: the API is plain HTTP and there is no client-side state to
keep in sync. The SDKs remove the fiddly parts.

## The contract

`spec/openapi.json` and `spec/config.v1.json` are pinned copies of the API contract, generated in
[twigg-api](https://github.com/Twigg-AI-Ltd/twigg-api). `spec/SOURCE` records the commit they came
from. Every SDK generates its types from these files.

```bash
node scripts/sync-spec.mjs            # copy from ../twigg-api (or pass its path)
node scripts/sync-spec.mjs --check    # compare with the live API and website
```

Then regenerate the TypeScript types with `pnpm --dir typescript/packages/sdk gen:types`. CI runs
the drift check daily.

## Shared fixtures

`fixtures/streams/` holds response streams recorded against production and the result each must
accumulate to. Both SDKs' test suites check them; see [fixtures/README.md](fixtures/README.md).

## Developing the TypeScript packages

```bash
cd typescript
pnpm install
pnpm check   # typecheck, lint, test
pnpm build
```

## More

- [examples/](examples): one idea per script, TypeScript and Python side by side.
- [AGENTS.md](AGENTS.md): how to work on this repository (checks, generated code, rules).
- [RELEASING.md](RELEASING.md): how a release is cut.
- [PLAN.md](PLAN.md): the design and the decisions behind it.
