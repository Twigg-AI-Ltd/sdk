import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolResult, tool } from "../src/index.js";
import { doneEvent, ids, runEvent, setup, sseResponse, sseText } from "./helpers.js";

const readFile = tool({
  name: "read_file",
  description: "Read a file",
  input: z.object({ path: z.string() }),
  run: ({ path }) => `contents of ${path}`,
});

function callTurn(calls: { id: string; name: string; args: string }[]) {
  return sseResponse(
    sseText([
      runEvent,
      ...calls.flatMap((c): [string, unknown][] => [
        ["block_start", { kind: "tool_call", tool_use_id: c.id, tool_name: c.name }],
        ["delta", { kind: "tool_input", text: c.args }],
        ["block_stop", {}],
      ]),
      doneEvent({
        stop_reason: "tool_use",
        pending_tool_calls: calls.map((c) => ({ tool_use_id: c.id, tool_name: c.name })),
      }),
    ]),
  );
}

function answerTurn(text: string) {
  return sseResponse(
    sseText([
      runEvent,
      ["block_start", { kind: "text" }],
      ["delta", { kind: "text", text }],
      doneEvent(),
    ]),
  );
}

const ask = { model: "claude-opus-5", input: [{ type: "prompt" as const, text: "go" }] };

describe("tool()", () => {
  it("derives the definition from a Zod schema, without the meta-schema URI", () => {
    expect(readFile.definition).toEqual({
      name: "read_file",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
  });

  it("validates input with the schema", async () => {
    expect(await readFile.parse({ path: "a" })).toEqual({ ok: true, value: { path: "a" } });
    const bad = await readFile.parse({ path: 3 });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.ok === false && bad.message).toMatch(/^path: /);
  });

  it("accepts a plain JSON Schema", () => {
    const t = tool<{ q: string }>({
      name: "search",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      run: ({ q }) => q,
    });
    expect(t.definition.input_schema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });
});

describe("runTools", () => {
  it("runs requested tools, submits results and stops when the model answers", async () => {
    const { twigg, api } = setup();
    api.reply(
      callTurn([{ id: "t1", name: "read_file", args: '{"path":"a.txt"}' }]),
      answerTurn("Done"),
    );
    const outcome = await twigg.responses
      .runTools(ids.chat, { ...ask, tools: [readFile], idempotencyKey: "job-7" })
      .final();
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.result.text).toBe("Done");
    expect(outcome.turns).toHaveLength(2);
    expect(api.requests[0]?.body).toMatchObject({
      idempotency_key: "job-7-0",
      tools: [readFile.definition],
    });
    expect(api.requests[1]?.body).toMatchObject({
      idempotency_key: "job-7-1",
      input: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          tool_name: "read_file",
          text: "contents of a.txt",
          is_error: false,
        },
      ],
    });
  });

  it("returns invalid arguments and thrown errors to the model as errors", async () => {
    const boom = tool({
      name: "boom",
      inputSchema: { type: "object" },
      run: () => {
        throw new Error("disk full");
      },
    });
    const { twigg, api } = setup();
    api.reply(
      callTurn([
        { id: "t1", name: "read_file", args: '{"path":7}' },
        { id: "t2", name: "boom", args: "{}" },
        { id: "t3", name: "read_file", args: "{not json" },
      ]),
      answerTurn("ok"),
    );
    await twigg.responses.runTools(ids.chat, { ...ask, tools: [readFile, boom] }).final();
    const input =
      (api.requests[1]?.body as { input: { text: string; is_error: boolean }[] } | undefined)
        ?.input ?? [];
    expect(input.map((p) => p.is_error)).toEqual([true, true, true]);
    expect(input[0]?.text).toMatch(/^Invalid arguments for read_file: path:/);
    expect(input[1]?.text).toBe("Error: disk full");
    expect(input[2]?.text).toMatch(/^The arguments were not valid JSON/);
  });

  it("rethrows a tool error when asked to", async () => {
    const boom = tool({
      name: "boom",
      inputSchema: { type: "object" },
      run: () => Promise.reject(new Error("x")),
    });
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "boom", args: "{}" }]));
    await expect(
      twigg.responses.runTools(ids.chat, { ...ask, tools: [boom], onToolError: "throw" }).final(),
    ).rejects.toThrow("x");
  });

  it("runs handlers for published tools without sending definitions", async () => {
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "lookup", args: '{"id":1}' }]), answerTurn("ok"));
    await twigg.responses
      .runTools(ids.chat, { ...ask, handlers: { lookup: (input) => ({ found: input }) } })
      .final();
    expect(api.requests[0]?.body).not.toHaveProperty("tools");
    expect(api.requests[1]?.body).toMatchObject({ input: [{ text: '{"found":{"id":1}}' }] });
  });

  it("stops with the calls pending when a tool has no handler", async () => {
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "mystery", args: "{}" }]));
    const outcome = await twigg.responses.runTools(ids.chat, { ...ask, tools: [readFile] }).final();
    expect(outcome.stopReason).toBe("unhandled_tool_calls");
    expect(outcome.result.pendingToolCalls.map((c) => c.name)).toEqual(["mystery"]);
    expect(api.requests).toHaveLength(1);
  });

  it("does not treat Object.prototype members as handlers", async () => {
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "constructor", args: '{"a":1}' }]));
    const outcome = await twigg.responses
      .runTools(ids.chat, { ...ask, handlers: { lookup: () => "ok" } })
      .final();
    expect(outcome.stopReason).toBe("unhandled_tool_calls");
    expect(api.requests).toHaveLength(1);
  });

  it("stops at maxIterations", async () => {
    const { twigg, api } = setup();
    api.reply(
      callTurn([{ id: "t1", name: "read_file", args: '{"path":"a"}' }]),
      callTurn([{ id: "t2", name: "read_file", args: '{"path":"b"}' }]),
    );
    const outcome = await twigg.responses
      .runTools(ids.chat, { ...ask, tools: [readFile], maxIterations: 2 })
      .final();
    expect(outcome.stopReason).toBe("max_iterations");
    expect(api.requests).toHaveLength(2);
  });

  it("sends media and error flags from a ToolResult", async () => {
    const shot = tool({
      name: "screenshot",
      inputSchema: { type: "object" },
      run: () =>
        new ToolResult({
          text: "see image",
          media: [{ mime: "image/png", data_base64: "AAAA" }],
          trust: "untrusted",
        }),
    });
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "screenshot", args: "" }]), answerTurn("nice"));
    await twigg.responses.runTools(ids.chat, { ...ask, tools: [shot] }).final();
    expect(api.requests[1]?.body).toMatchObject({
      input: [
        {
          text: "see image",
          is_error: false,
          trust: "untrusted",
          media: [{ mime: "image/png", data_base64: "AAAA" }],
        },
      ],
    });
  });

  it("yields each turn's events and the results it submitted", async () => {
    const { twigg, api } = setup();
    api.reply(callTurn([{ id: "t1", name: "read_file", args: '{"path":"a"}' }]), answerTurn("ok"));
    const kinds: string[] = [];
    for await (const event of twigg.responses.runTools(ids.chat, { ...ask, tools: [readFile] }))
      kinds.push(event.type === "event" ? `${event.iteration}:${event.event.event}` : event.type);
    expect(kinds).toContain("tool_result");
    expect(kinds.filter((k) => k.endsWith(":done"))).toEqual(["0:done", "1:done"]);
  });
});
