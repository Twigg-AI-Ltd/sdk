import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  InsufficientBalanceError,
  StreamError,
  type StreamEvent,
} from "../src/index.js";
import { parseSse } from "../src/streaming/sse.js";
import {
  apiError,
  doneEvent,
  ids,
  json,
  runEvent,
  setup,
  sseResponse,
  sseText,
  textTurn,
} from "./helpers.js";

const prompt = { model: "claude-opus-5", input: [{ type: "prompt" as const, text: "Hi" }] };

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: ids.run,
    chat_id: ids.chat,
    status,
    created_at: "2026-10-14T10:00:00Z",
    usage: null,
    cost: null,
    error: null,
    ...extra,
  };
}

describe("streaming a turn", () => {
  it("sends nothing until used, then resolves the result", async () => {
    const { twigg, api } = setup();
    const stream = twigg.responses.create(ids.chat, prompt);
    expect(api.requests).toHaveLength(0);
    api.reply(sseResponse(textTurn("Hello there")));
    const result = await stream.final();
    expect(result).toMatchObject({
      runId: ids.run,
      text: "Hello there",
      stopReason: "end_turn",
      cost: "0.0010",
      recovered: false,
    });
    expect(api.last.method).toBe("POST");
    expect(api.last.url.pathname).toBe(`/api/v1/chats/${ids.chat}/responses`);
    expect(api.last.headers.accept).toBe("text/event-stream");
  });

  it("generates an idempotency key, and keeps one the caller gave", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn()), sseResponse(textTurn()));
    await twigg.responses.create(ids.chat, prompt).final();
    expect(api.requests[0]?.body).toMatchObject({
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await twigg.responses.create(ids.chat, { ...prompt, idempotency_key: "mine" }).final();
    expect(api.requests[1]?.body).toMatchObject({ idempotency_key: "mine" });
  });

  it("yields every event to each iterator and calls listeners", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn("Hi")));
    const texts: [string, string][] = [];
    const stream = twigg.responses
      .create(ids.chat, prompt)
      .on("text", (delta, snapshot) => texts.push([delta, snapshot]));
    const first: string[] = [];
    for await (const event of stream) first.push(event.event);
    const second: string[] = [];
    for await (const event of stream) second.push(event.event);
    expect(first).toEqual(["run", "config_warnings", "block_start", "delta", "block_stop", "done"]);
    expect(second).toEqual(first);
    expect(texts).toEqual([["Hi", "Hi"]]);
    await expect(stream.runId).resolves.toBe(ids.run);
  });

  it("reports tool calls as their arguments complete", async () => {
    const { twigg, api } = setup();
    api.reply(
      sseResponse(
        sseText([
          runEvent,
          ["block_start", { kind: "tool_call", tool_use_id: "t1", tool_name: "read_file" }],
          ["delta", { kind: "tool_input", text: '{"path":' }],
          ["delta", { kind: "tool_input", text: '"a.txt"}' }],
          ["block_stop", {}],
          doneEvent({
            stop_reason: "tool_use",
            pending_tool_calls: [{ tool_use_id: "t1", tool_name: "read_file" }],
          }),
        ]),
      ),
    );
    const calls: unknown[] = [];
    const result = await twigg.responses
      .create(ids.chat, prompt)
      .on("toolCall", (call) => calls.push(call.input))
      .final();
    expect(calls).toEqual([{ path: "a.txt" }]);
    expect(result.pendingToolCalls).toEqual([
      { id: "t1", name: "read_file", input: { path: "a.txt" }, rawInput: '{"path":"a.txt"}' },
    ]);
  });

  it("passes warnings to the stream and the client hook", async () => {
    const seen: unknown[] = [];
    const { twigg, api } = setup({ onWarning: (w) => seen.push(w) });
    const warning = { code: "global_instruction_replaced", namespace: "acme" };
    api.reply(
      sseResponse(sseText([runEvent, ["config_warnings", { warnings: [warning] }], doneEvent()])),
    );
    const result = await twigg.responses.create(ids.chat, prompt).final();
    expect(seen).toEqual([{ source: "config", ...warning }]);
    expect(result.warnings).toEqual(seen);
  });
});

describe("failures", () => {
  it("rejects with the HTTP error when the stream never opens", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(402, "payment_required"));
    const stream = twigg.responses.create(ids.chat, prompt);
    await expect(stream.final()).rejects.toBeInstanceOf(InsufficientBalanceError);
    await expect(stream.runId).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("retries a 503 before the stream opens with the same idempotency key", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(503, "unavailable"), sseResponse(textTurn()));
    await twigg.responses.create(ids.chat, prompt).final();
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]?.body).toEqual(api.requests[1]?.body);
  });

  it("turns an error event into a StreamError after yielding it", async () => {
    const { twigg, api } = setup();
    api.reply(
      sseResponse(
        sseText([
          runEvent,
          ["error", { code: "external_service_error", message: "provider down" }],
        ]),
      ),
    );
    const stream = twigg.responses.create(ids.chat, prompt);
    const seen: string[] = [];
    const failure = await (async () => {
      for await (const event of stream) seen.push(event.event);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["run", "error"]);
    expect(failure).toBeInstanceOf(StreamError);
    expect(failure).toMatchObject({ code: "external_service_error", runId: ids.run });
  });
});

describe("recovery", () => {
  it("rebuilds the result from the run and history when the connection drops mid-turn", async () => {
    const { twigg, api } = setup();
    api.reply(
      sseResponse(
        sseText([
          runEvent,
          ["block_start", { kind: "text" }],
          ["delta", { kind: "text", text: "Hal" }],
        ]),
        {
          dropAfter: true,
        },
      ),
      json(run("running")),
      json(
        run("succeeded", {
          cost: "0.0042",
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
          },
        }),
      ),
      json({
        data: [
          {
            id: "p1",
            ordinal: 1,
            role: "user",
            created_at: "2026-10-14T10:00:00Z",
            part: { type: "prompt", text: "Hi" },
          },
          {
            id: "p2",
            ordinal: 2,
            role: "assistant",
            created_at: "2026-10-14T10:00:01Z",
            part: { type: "reasoning", text: "think" },
          },
          {
            id: "p3",
            ordinal: 3,
            role: "assistant",
            created_at: "2026-10-14T10:00:02Z",
            part: { type: "message", text: "Hallo" },
          },
          {
            id: "p4",
            ordinal: 4,
            role: "assistant",
            created_at: "2026-10-14T10:00:03Z",
            part: {
              type: "tool_call",
              tool_use_id: "t9",
              tool_name: "lookup",
              arguments: '{"q":1}',
            },
          },
        ],
        first_ordinal: 1,
        last_ordinal: 4,
        has_more: true,
      }),
    );
    const stream = twigg.responses.create(ids.chat, prompt);
    const events: StreamEvent[] = [];
    stream.on("event", (e) => events.push(e));
    const result = await stream.final();
    expect(result).toMatchObject({
      recovered: true,
      text: "Hallo",
      reasoning: "think",
      stopReason: "tool_use",
      cost: "0.0042",
    });
    expect(result.pendingToolCalls.map((c) => c.input)).toEqual([{ q: 1 }]);
    expect(events.at(-1)?.event).toBe("recovered");
    expect(api.requests.map((r) => r.url.pathname)).toEqual([
      `/api/v1/chats/${ids.chat}/responses`,
      `/api/v1/runs/${ids.run}`,
      `/api/v1/runs/${ids.run}`,
      `/api/v1/chats/${ids.chat}/history`,
    ]);
  });

  it("resubmits after a drop before the run is named, and recovers from the 409", async () => {
    const { twigg, api } = setup();
    api.reply(
      new TypeError("socket hang up"),
      json(
        {
          error: {
            code: "conflict",
            message: `idempotency key 'k' was already used; it belongs to run ${ids.run}`,
          },
        },
        409,
      ),
      json(run("cancelled")),
      json({ data: [], first_ordinal: null, last_ordinal: null, has_more: false }),
    );
    const result = await twigg.responses.create(ids.chat, prompt).final();
    expect(result).toMatchObject({ runId: ids.run, recovered: true, stopReason: "aborted" });
    expect(api.requests[0]?.body).toEqual(api.requests[1]?.body);
  });

  it("reports a failed run as a StreamError", async () => {
    const { twigg, api } = setup();
    api.reply(
      sseResponse(sseText([runEvent]), { dropAfter: true }),
      json(run("failed", { error: "boom" })),
    );
    await expect(twigg.responses.create(ids.chat, prompt).final()).rejects.toMatchObject({
      name: "StreamError",
      code: "run_failed",
      message: "boom",
    });
  });

  it("raises ConnectionError instead when recovery is off", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(sseText([runEvent]), { dropAfter: true }));
    await expect(
      twigg.responses.create(ids.chat, prompt, { recover: false }).final(),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it("treats a silent connection as dropped", async () => {
    const { twigg, api } = setup();
    const silent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText([runEvent])));
      },
    });
    api.reply(
      new Response(silent),
      json(run("succeeded")),
      json({ data: [], first_ordinal: null, last_ordinal: null, has_more: false }),
    );
    const result = await twigg.responses.create(ids.chat, prompt, { idleTimeout: 20 }).final();
    expect(result.recovered).toBe(true);
  });
});

describe("aborting", () => {
  it("does nothing for a stream that never started", async () => {
    const { twigg, api } = setup();
    await twigg.responses.create(ids.chat, prompt).abort();
    expect(api.requests).toHaveLength(0);
  });

  it("never leaves an unhandled rejection when the stream fails or the turn already ended", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { twigg, api } = setup();
      api.reply(json({ error: { code: "insufficient_balance", message: "no credit" } }, 402));
      const failing = twigg.responses.create(ids.chat, prompt);
      const final = failing.final().catch((e: unknown) => e);
      void failing.abort();
      expect(await final).toBeInstanceOf(Error);

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(sseText([runEvent])));
          await gate;
          controller.enqueue(encoder.encode(sseText([doneEvent()])));
          controller.close();
        },
      });
      // The turn finishes as the abort arrives: the API answers 409.
      api.reply(new Response(body), () => {
        release();
        return json({ error: { code: "no_active_turn", message: "nothing to abort" } }, 409);
      });
      const finished = twigg.responses.create(ids.chat, prompt);
      const done = finished.final();
      await expect(finished.abort()).resolves.toBeUndefined();
      await done;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stops the run on the server and lets the stream finish", async () => {
    const { twigg, api } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sseText([runEvent])));
        await gate;
        controller.enqueue(encoder.encode(sseText([doneEvent({ stop_reason: "aborted" })])));
        controller.close();
      },
    });
    api.reply(new Response(body), () => {
      release();
      return json({ run_id: ids.run, chat_id: ids.chat, status: "aborting" }, 202);
    });
    const stream = twigg.responses.create(ids.chat, prompt);
    const final = stream.final();
    await stream.abort();
    const result = await final;
    expect(result.stopReason).toBe("aborted");
    expect(api.requests[1]?.url.pathname).toBe(`/api/v1/chats/${ids.chat}/abort`);
    expect(api.requests[1]?.url.searchParams.get("run_id")).toBe(ids.run);
  });
});

describe("forwarding", () => {
  it("re-emits the stream as server-sent events", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn("Hi")));
    const response = twigg.responses.create(ids.chat, prompt).toResponse();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const names: string[] = [];
    // biome-ignore lint/style/noNonNullAssertion: toResponse always has a body.
    for await (const frame of parseSse(response.body!)) names.push(frame.event);
    expect(names).toEqual(["run", "block_start", "delta", "block_stop", "done"]);
  });

  it("keeps warnings and cost on the server unless asked to forward everything", async () => {
    const { twigg, api } = setup();
    const turn = sseText([
      runEvent,
      ["config_warnings", { warnings: [{ code: "provider_key_paused", key_last4: "abcd" }] }],
      doneEvent({ cost: "0.25" }),
    ]);
    api.reply(sseResponse(turn), sseResponse(turn));
    const read = async (response: Response) => {
      const frames: { event: string; data: string }[] = [];
      // biome-ignore lint/style/noNonNullAssertion: toResponse always has a body.
      for await (const frame of parseSse(response.body!)) frames.push(frame);
      return frames;
    };
    const content = await read(twigg.responses.create(ids.chat, prompt).toResponse());
    expect(content.map((f) => f.event)).toEqual(["run", "done"]);
    expect(JSON.stringify(content)).not.toContain("abcd");
    expect(JSON.parse(content[1]?.data ?? "{}").cost).toBeNull();

    const all = await read(
      twigg.responses.create(ids.chat, prompt).toResponse({}, { events: "all" }),
    );
    expect(all.map((f) => f.event)).toEqual(["run", "config_warnings", "done"]);
    expect(JSON.parse(all[2]?.data ?? "{}").cost).toBe("0.25");
  });

  it("forwards a failure as an error event", async () => {
    const { twigg, api } = setup({ maxRetries: 0 });
    api.reply(apiError(402, "payment_required", "Top up"));
    const response = twigg.responses.create(ids.chat, prompt).toResponse();
    const frames: { event: string; data: string }[] = [];
    // biome-ignore lint/style/noNonNullAssertion: toResponse always has a body.
    for await (const frame of parseSse(response.body!)) frames.push(frame);
    expect(frames).toEqual([
      {
        event: "error",
        data: JSON.stringify({ code: "payment_required", message: "The turn failed" }),
      },
    ]);
  });
});

describe("retry", () => {
  it("submits no input with retry_of", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn()));
    await twigg.responses.retry(ids.chat, ids.run, { model: "claude-opus-5" }).final();
    expect(api.last.body).toMatchObject({ input: [], retry_of: ids.run, model: "claude-opus-5" });
  });
});

describe("closing", () => {
  function endlessBody() {
    const state = { cancelled: false };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText([runEvent])));
        controller.enqueue(encoder.encode(sseText([["delta", { kind: "text", text: "Hi" }]])));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  }

  it("releases the connection when a for await loop breaks early", async () => {
    const { twigg, api } = setup();
    const { body, state } = endlessBody();
    api.reply(new Response(body));
    const stream = twigg.responses.create(ids.chat, prompt);
    for await (const event of stream) if (event.event === "delta") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.cancelled).toBe(true);
    await expect(stream.final()).rejects.toMatchObject({ code: "closed" });
    expect(api.requests).toHaveLength(1); // no recovery polling after a deliberate close
  });

  it("keeps reading after a break when final() still wants the result", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn("Hello")));
    const stream = twigg.responses.create(ids.chat, prompt);
    const result = stream.final();
    for await (const event of stream) if (event.event === "run") break;
    expect((await result).text).toBe("Hello");
  });

  it("close() detaches without stopping the run", async () => {
    const { twigg, api } = setup();
    const { body, state } = endlessBody();
    api.reply(new Response(body));
    const stream = twigg.responses.create(ids.chat, prompt);
    const final = stream.final();
    await stream.runId;
    stream.close();
    await expect(final).rejects.toMatchObject({ code: "closed" });
    expect(state.cancelled).toBe(true);
    expect(api.requests.some((r) => r.url.pathname.endsWith("/abort"))).toBe(false);
  });
});
