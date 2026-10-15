// One test per finding from the first code review, so none can come back unnoticed.
import { describe, expect, it } from "vitest";
import { tool } from "../src/index.js";
import { MockTwigg, streamBuilder } from "../src/testing/index.js";
import { doneEvent, ids, json, runEvent, setup, sseResponse, sseText } from "./helpers.js";

const model = { model: "m" };

describe("recovery picks the right turn", () => {
  it("replaying an older key returns that turn, not a later one", async () => {
    const twigg = new MockTwigg().respond(
      streamBuilder().text("first answer").done(),
      streamBuilder().text("second answer").done(),
    );
    const chat = await twigg.chats.open({}, model);
    const first = await chat.send("q1", { idempotency_key: "k1" });
    await chat.send("q2", { idempotency_key: "k2" });
    const replay = await chat.send("q1", { idempotency_key: "k1" });
    expect(replay).toMatchObject({ runId: first.runId, text: "first answer", recovered: true });
  });
});

describe("a restarted tool loop", () => {
  it("does not run tools that already ran", async () => {
    const runs: string[] = [];
    let crash = true;
    const step = tool<{ n: string }>({
      name: "step",
      inputSchema: { type: "object" },
      run: ({ n }) => {
        runs.push(n);
        if (n === "B" && crash) {
          crash = false;
          throw new Error("process died");
        }
        return `did ${n}`;
      },
    });
    const twigg = new MockTwigg().respond(
      streamBuilder().toolCall("step", { n: "A" }).done(),
      streamBuilder().toolCall("step", { n: "B" }).done(),
      streamBuilder().text("all done").done(),
    );
    const chat = await twigg.chats.open({}, model);
    const options = { tools: [step], idempotencyKey: "job", onToolError: "throw" as const };
    await expect(chat.runTools("go", options).final()).rejects.toThrow("process died");
    const outcome = await chat.runTools("go", options).final();
    expect(outcome.result.text).toBe("all done");
    expect(runs).toEqual(["A", "B", "B"]);
  });
});

describe("listeners", () => {
  it("a throwing listener fails the stream instead of looking like a dropped connection", async () => {
    const twigg = new MockTwigg().respond(streamBuilder().text("hi").done());
    const chat = await twigg.chats.open({}, model);
    const stream = chat.stream("x").on("text", () => {
      throw new Error("render failed");
    });
    await expect(stream.final()).rejects.toThrow("render failed");
    expect(twigg.server.calls.some((c) => c.path.startsWith("/api/v1/runs/"))).toBe(false);
  });

  it("reports a repeated warning once", async () => {
    const seen: unknown[] = [];
    const twigg = new MockTwigg({ onWarning: (w) => seen.push(w) });
    const warning = {
      code: "global_instruction_replaced" as const,
      namespace: "acme",
      message: "acme replaces the global instruction",
    };
    twigg.respond(streamBuilder().warning(warning).compacting().warning(warning).text("ok").done());
    const result = await (await twigg.chats.open({}, model)).send("x");
    expect(seen).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("runId and abort", () => {
  it("awaiting only runId never leaves an unhandled rejection", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(sseText([runEvent, ["error", { code: "x", message: "failed" }]])));
    const stream = twigg.responses.create(ids.chat, {
      ...model,
      input: [{ type: "prompt", text: "x" }],
    });
    await expect(stream.runId).resolves.toBe(ids.run);
    // Vitest fails the run on an unhandled rejection; give one the chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("abort() called twice before the run is named sends one request", async () => {
    const { twigg, api } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(encoder.encode(sseText([runEvent])));
        controller.enqueue(encoder.encode(sseText([doneEvent({ stop_reason: "aborted" })])));
        controller.close();
      },
    });
    api.reply(
      new Response(body),
      json({ run_id: ids.run, chat_id: ids.chat, status: "aborting" }, 202),
    );
    const stream = twigg.responses.create(ids.chat, {
      ...model,
      input: [{ type: "prompt", text: "x" }],
    });
    const result = stream.final();
    const first = stream.abort();
    const second = stream.abort();
    release();
    await Promise.all([first, second]);
    await result;
    expect(api.requests.filter((r) => r.url.pathname.endsWith("/abort"))).toHaveLength(1);
  });
});

describe("tool concurrency", () => {
  it("treats a non-positive concurrency as one", async () => {
    const echo = tool({ name: "echo", inputSchema: { type: "object" }, run: () => "ok" });
    const twigg = new MockTwigg().respond(
      streamBuilder().toolCall("echo").toolCall("echo").done(),
      streamBuilder().text("fine").done(),
    );
    const chat = await twigg.chats.open({}, model);
    const outcome = await chat.runTools("go", { tools: [echo], toolConcurrency: 0 }).final();
    expect(outcome.result.text).toBe("fine");
    const submitted = twigg.server.calls.filter((c) => c.path.endsWith("/responses"))[1]?.body as {
      input: unknown[];
    };
    expect(submitted.input).toHaveLength(2);
    expect(submitted.input).not.toContain(null);
  });
});
