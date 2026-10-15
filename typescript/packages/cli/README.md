# @twigg/cli

Twigg configuration as code. Declare system instructions, tools, context budgets and retention
for your organisation and its namespaces in one file, review a plan, and apply it from CI.

```bash
npm install --save-dev @twigg/cli
export TWIGG_API_KEY=tw_...
npx twigg config pull      # start from what is configured today
npx twigg config plan      # what would change
npx twigg config apply     # make it so
```

## The file

`twigg.config.yaml`, `twigg.config.json` or `twigg.config.ts`. YAML and JSON are validated
against [config.v1.json](https://twigg.ai/schemas/config.v1.json); the first line below gives
editors autocomplete and validation.

```yaml
# yaml-language-server: $schema=https://twigg.ai/schemas/config.v1.json
version: 1
global:
  instructions: { $file: prompts/global.md }
namespaces:
  acme:
    instructions:
      mode: append
      body: { $file: prompts/acme.md }
    tools:
      definitions:
        - $file: tools/read_file.json
    budgets:
      default: { version: 3, headroom: 0.2, history_mode: summarize }
      claude-opus-5: { version: 3, headroom: 0.15, max_history_tokens: 200000 }
  acme/support:
    instructions:
      mode: replace
      body: { $file: prompts/support.md }
    tools: null
```

The same in TypeScript, where tools can be the SDK's `tool()` objects your agent already runs:

```ts
import { defineConfig, file } from "@twigg/cli";
import { readFile } from "./tools";

export default defineConfig({
  version: 1,
  global: { instructions: file("prompts/global.md") },
  namespaces: {
    acme: { tools: { definitions: [readFile] } },
  },
});
```

Rules:

- `global` is the organisation-wide scope; `namespaces` holds the rest. A child such as
  `acme/support` resolves on top of `acme`.
- A scope or surface left out is **unmanaged** and never touched. `null` withdraws the scope's
  override so it inherits from its parent.
- `instructions` and `tools` take a `mode`, `append` (the default) or `replace`. A bare string
  or `$file` for instructions means `append`.
- `budgets` are keyed by `default` or a catalogue model name. The map is the scope's whole set:
  an active budget for a model not listed is withdrawn.
- `$file` paths are relative to the configuration file: Markdown or text for instructions, JSON
  or YAML for tools, budgets and retention.
- `${TWIGG_VAR_NAME}` is substituted in strings, so one file can serve staging and production.
  Only variables named `TWIGG_VAR_*` are read, so a config cannot pull `TWIGG_API_KEY` or other
  secrets into plan output or published configuration. Write `$${NAME}` for a literal `${NAME}`.

## Commands

| Command | What it does |
|---|---|
| `twigg config plan` | Show what applying would change. Exit 2 when there are changes. |
| `twigg config apply` | Show the plan, ask, then publish and withdraw. `--yes` skips the question. |
| `twigg config pull` | Write the current configuration as a file, instructions as Markdown. |
| `twigg config rollback --surface tools` | Restore the previous version, or `--to <n>`. |
| `twigg config resolve` | The effective configuration for a scope, after inheritance. |
| `twigg config history` | Versions of each surface, the active one marked. |
| `twigg config validate` | Check the file against the schema without calling the API. |
| `twigg config convert --format ts` | Rewrite the file as TypeScript, YAML or JSON. |

`--scope acme` narrows plan, apply and pull to `acme` and every namespace beneath it; for
rollback, resolve and history it selects the scope (the default is the organisation-wide one).
Overrides beneath the scope that the file does not declare are listed as unmanaged, so you can
see when, say, `acme/support` replaces what you are changing in `acme`. `--prune` withdraws them.

Plans compare normalised values: line endings and trailing whitespace in instructions, tool
order and key order, and fields equal to the platform defaults do not count as changes.

Apply runs the organisation-wide scope first, then parents before children. Before each change
it reads the active version again and stops if someone changed it since the plan, so a console
edit is never silently overwritten. `--report apply.json` records what was applied, including
on failure.

There is no state file: Twigg's version history is the state.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | No changes |
| 2 | Changes planned (`plan`) or made (`apply`, `rollback`) |
| 1 | Error |

## Credentials

`TWIGG_API_KEY`, or a profile from `~/.config/twigg/credentials` chosen with `--profile` or
`TWIGG_PROFILE`:

```ini
[default]
api_key = tw_...

[staging]
api_key = tw_...
base_url = https://api.staging.example
```

## CI

Plan on pull requests, posting the plan as a comment; apply on merge.

```yaml
name: Twigg configuration
on:
  pull_request:
    paths: ["twigg.config.*", "prompts/**", "tools/**"]
  push:
    branches: [main]
    paths: ["twigg.config.*", "prompts/**", "tools/**"]

jobs:
  twigg:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    env:
      TWIGG_API_KEY: ${{ secrets.TWIGG_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Plan
        if: github.event_name == 'pull_request'
        run: |
          set +e
          npx --yes @twigg/cli config plan > plan.txt
          code=$?
          cat plan.txt
          [ "$code" = 1 ] && exit 1
          {
            echo '### Twigg configuration plan'
            echo '```'
            cat plan.txt
            echo '```'
          } > comment.md
          gh pr comment ${{ github.event.pull_request.number }} --body-file comment.md
        env:
          GH_TOKEN: ${{ github.token }}
      - name: Apply
        if: github.event_name == 'push'
        run: |
          npx --yes @twigg/cli config apply --yes --report apply.json || [ $? = 2 ]
      - uses: actions/upload-artifact@v4
        if: github.event_name == 'push'
        with:
          name: twigg-apply-report
          path: apply.json
```

Exit code 2 means "there were changes", so the steps treat it as success and only 1 fails the
job.
