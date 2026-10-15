# Shared fixtures

Every SDK's test suite reads these files, so the SDKs cannot disagree about what a stream means.

## streams/

`<name>.sse` is a response stream exactly as the API sent it, recorded against production by
twigg-agent. `<name>.json` is what accumulating it must produce, in a language-neutral shape:

```json
{
  "run_id": "...",
  "chat_id": "...",
  "text": "all text blocks joined",
  "reasoning": "all reasoning blocks joined",
  "refusal": null,
  "blocks": [
    { "type": "text", "text": "..." },
    { "type": "tool_call", "id": "...", "name": "...", "input": {}, "raw_input": "..." }
  ],
  "pending_tool_call_ids": ["..."],
  "closed_tool_call_ids": [],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0 },
  "cost": "0.00003696",
  "cost_currency": "USD",
  "model_served": "...",
  "warnings": []
}
```

Rules every SDK follows:

- Empty text, reasoning and refusal blocks are dropped; tool-call blocks are always kept.
- A tool call's `input` is its `raw_input` parsed as JSON, with an empty string read as `{}`.
  When it does not parse, `input` is `null` and the block carries `input_error`.
- `cost` stays a decimal string.

Each SDK's tests map its own result type into this shape and compare.
