# Examples

Small scripts, one idea each, in TypeScript (`typescript/`) and Python (`python/`). Both sets do
the same things with the same numbering, so they double as a side-by-side reference. Each file
starts with a comment saying what it shows.

They make real requests: set `TWIGG_API_KEY` first. Chats go in the `examples` namespace with the
`gpt-6-luna` model; `13` deletes them afterwards.

```bash
export TWIGG_API_KEY=tw_...

cd typescript && npm install && node 02-send.mjs
pip install twigg && python python/02_send.py
```

| # | What |
|---|---|
| 01 | List the models you can use |
| 02 | Send a message; read the text, cost and usage |
| 03 | Stream text as it arrives |
| 04 | List chats in a namespace |
| 05 | Read a chat's history, oldest first |
| 06 | Continue the most recent chat |
| 07 | A local tool and the tool loop |
| 08 | Raw stream events |
| 09 | Namespace scope and system instructions |
| 10 | Errors |
| 11 | Abort a turn mid-stream |
| 12 | TypeScript: `MockTwigg` for tests, no network. Python: the async client |
| 13 | Delete the chats the examples made |
| 14 | History with typed parts (`HistoryPrompt`, `HistoryToolCall`, ...) |
| 15 | Inspect a run, wait for its cost to settle, query usage |
| 16 | The tool loop by hand: pending calls and `tool_result` parts |
| 17 | TypeScript: forward a stream to a browser |
| 18 | A chat addressed by your own id (a phone number): created by its first message |
| 19 | Import a conversation from elsewhere into a chat by your own id, then continue it |

`cli/` is configuration as code with `@twigg/cli`: `bash cli/run.sh` validates, plans, applies,
re-plans, resolves and then withdraws `cli/twigg.config.yaml` in the `examples/cli` namespace.
