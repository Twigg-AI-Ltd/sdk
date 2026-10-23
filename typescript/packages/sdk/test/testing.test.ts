import { describe, expect, it } from "vitest";
import { readForwardedStream } from "../src/browser.js";
import { Twigg, tool } from "../src/index.js";
import { MockTwigg, recordingFetch, replayFetch, streamBuilder } from "../src/testing/index.js";

describe("MockTwigg", () => {
  it("runs a whole tool loop in memory and keeps believable history", async () => {
    const twigg = new MockTwigg();
    const lookup = tool<{ city: string }>({
      name: "weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      run: ({ city }) => `Sunny in ${city}`,
    });
    twigg.respond(
      streamBuilder().text("Checking.").toolCall("weather", { city: "Leeds" }).done(),
      ({ history }) => {
        const last = history.at(-1)?.part;
        return streamBuilder()
          .text(last?.type === "tool_result" ? `Report: ${last.text}` : "?")
          .done();
      },
    );

    const chat = await twigg.chats.open({ namespace: "acme" }, { model: "claude-opus-5" });
    const outcome = await chat.runTools("Weather in Leeds?", { tools: [lookup] }).final();
    expect(outcome.result.text).toBe("Report: Sunny in Leeds");

    const kinds: string[] = [];
    for await (const part of chat.history({ after_ordinal: -1 })) kinds.push(part.part.type);
    expect(kinds).toEqual(["prompt", "message", "tool_call", "tool_result", "message"]);
    const run = await twigg.runs.get(outcome.result.runId);
    expect(run.status).toBe("succeeded");
    expect(twigg.server.calls.filter((c) => c.path.endsWith("/responses"))).toHaveLength(2);
  });

  it("lets the SDK recover a turn whose connection dropped", async () => {
    const twigg = new MockTwigg();
    twigg.respond(streamBuilder().text("All ", "of it").done().disconnectAfter(2));
    const chat = await twigg.chats.open();
    const result = await chat.send("Hi", { model: "m" });
    expect(result).toMatchObject({ recovered: true, text: "All of it", stopReason: "end_turn" });
  });

  it("filters chat listings by namespace subtree and pages them", async () => {
    const twigg = new MockTwigg();
    for (const ns of ["acme", "acme/a", "other", "acme/b"])
      await twigg.chats.create({ namespace: ns });
    const seen: (string | null | undefined)[] = [];
    for await (const chat of twigg.chats.list({ namespace: "acme", limit: 2 }))
      seen.push((chat as { namespace?: string | null }).namespace);
    expect(seen).toEqual(["acme/b", "acme/a", "acme"]);
  });

  it("opens, gets and deletes chats by external id", async () => {
    const twigg = new MockTwigg();
    const first = await twigg.chats.openByExternalId("wa:1", { namespace: "acme" });
    const again = await twigg.chats.openByExternalId("wa:1");
    expect(again.id).toBe(first.id);
    await expect(twigg.chats.openByExternalId("wa:1", { namespace: null })).rejects.toMatchObject({
      status: 409,
      code: "external_id_namespace_mismatch",
    });
    await expect(twigg.chats.create({ external_id: "wa:1" })).rejects.toMatchObject({
      code: "external_id_taken",
    });
    expect((await twigg.chats.getByExternalId("wa:1")).id).toBe(first.id);
    await twigg.chats.deleteByExternalId("wa:1");
    await expect(twigg.chats.getByExternalId("wa:1")).rejects.toMatchObject({ status: 404 });
  });

  it("creates a chat addressed by external id on its first message", async () => {
    const twigg = new MockTwigg().respond(
      streamBuilder().text("Hello Ann").done(),
      streamBuilder().text("Again").done(),
    );
    const chat = twigg.chatByExternalId("+447700", { model: "m", chat: { namespace: "wa" } });
    const first = await chat.send("Hi");
    await chat.send("Hi again");
    expect(twigg.server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/chats/external/%2B447700/responses",
      "POST /api/v1/chats/external/%2B447700/responses",
    ]);
    const stored = await chat.get();
    expect(stored).toMatchObject({ id: first.chatId, external_id: "+447700", namespace: "wa" });
    const kinds: string[] = [];
    for await (const part of chat.history({ after_ordinal: -1 })) kinds.push(part.part.type);
    expect(kinds).toEqual(["prompt", "message", "prompt", "message"]);
    await expect(
      twigg.chatByExternalId("+447700", { model: "m", chat: { namespace: "other" } }).send("x"),
    ).rejects.toMatchObject({ code: "external_id_namespace_mismatch" });
  });

  it("imports a conversation once, into an empty chat", async () => {
    const twigg = new MockTwigg().respond(streamBuilder().text("Welcome back").done());
    const chat = twigg.chatByExternalId("wa:2", { model: "m", chat: { namespace: "wa" } });
    const result = await chat.importHistory([
      { type: "prompt", text: "Where is my order?" },
      { type: "tool_call", tool_use_id: "c1", name: "track", arguments: { id: 7 } },
      { type: "tool_result", tool_use_id: "c1", tool_name: "track", text: "shipped" },
      { type: "message", text: "It has shipped." },
    ]);
    expect(result).toMatchObject({ created_chat: true, imported_parts: 4, warnings: [] });
    expect(await chat.importHistory([{ type: "prompt", text: "again" }])).toMatchObject({
      skipped: true,
      existing_parts: 4,
    });
    await chat.send("Thanks");
    const kinds: string[] = [];
    for await (const part of chat.history({ after_ordinal: -1 })) kinds.push(part.part.type);
    expect(kinds).toEqual(["prompt", "tool_call", "tool_result", "message", "prompt", "message"]);
    expect(await chat.get()).toMatchObject({ namespace: "wa" });
    await expect(
      twigg.chats.importByExternalId("wa:2", {
        parts: [{ type: "prompt", text: "x" }],
        chat: { namespace: "other" },
      }),
    ).rejects.toMatchObject({ code: "external_id_namespace_mismatch" });
  });

  it("explains an unscripted turn", async () => {
    const twigg = new MockTwigg();
    const chat = await twigg.chats.open();
    await expect(chat.send("Hi", { model: "m" })).rejects.toThrow(/no scripted turn/);
  });
});

describe("record and replay", () => {
  it("replays recorded traffic, without headers", async () => {
    const mock = new MockTwigg().respond(streamBuilder().text("Hello").done());
    const recorder = recordingFetch(mock.server.fetch);
    const live = new Twigg({
      apiKey: "secret",
      baseURL: "https://mock.twigg.invalid",
      fetch: recorder.fetch,
    });
    const chat = await live.chats.open({}, { model: "m" });
    await chat.send("Hi");
    expect(JSON.stringify(recorder.recordings)).not.toContain("secret");

    const replayed = new Twigg({
      apiKey: "x",
      baseURL: "https://elsewhere.invalid",
      fetch: replayFetch(recorder.recordings),
    });
    const again = await replayed.chats.open({}, { model: "m" });
    expect((await again.send("Hi")).text).toBe("Hello");
    await expect(again.send("more")).rejects.toThrow(/No recording left/);
  });
});

describe("forwarding to a browser", () => {
  it("reads a forwarded stream back into the same result", async () => {
    const twigg = new MockTwigg().respond(
      streamBuilder().reasoning("hmm").text("Hi ", "there").toolCall("x", { a: 1 }).done(),
    );
    const chat = await twigg.chats.open({}, { model: "m" });
    const response = chat.stream("Hello").toResponse();
    const texts: string[] = [];
    const turn = readForwardedStream(response).on("text", (_, all) => texts.push(all));
    const result = await turn.final();
    expect(result.text).toBe("Hi there");
    expect(result.reasoning).toBe("hmm");
    expect(result.pendingToolCalls.map((c) => c.input)).toEqual([{ a: 1 }]);
    expect(texts).toEqual(["Hi ", "Hi there"]);
  });

  it("returns a recovered result and surfaces failures", async () => {
    const twigg = new MockTwigg().respond(
      streamBuilder().text("Recovered text").done().disconnectAfter(1),
      streamBuilder().error("external_service_error", "provider down"),
    );
    const chat = await twigg.chats.open({}, { model: "m" });
    const recovered = await readForwardedStream(chat.stream("a").toResponse()).final();
    expect(recovered).toMatchObject({ recovered: true, text: "Recovered text" });
    await expect(readForwardedStream(chat.stream("b").toResponse()).final()).rejects.toMatchObject({
      name: "StreamError",
      code: "external_service_error",
    });
  });
});
