import { describe, expect, it } from "vitest";
import { media, toParts } from "../src/index.js";
import { ids, json, setup, sseResponse, textTurn } from "./helpers.js";

const png = { mime: "image/png", data_base64: "iVBORw0KGgo=", filename: "a.png" };

describe("input", () => {
  it("joins strings and attachments into one prompt and keeps parts in place", () => {
    const result = { type: "tool_result" as const, tool_use_id: "t1", tool_name: "x", text: "r" };
    expect(toParts(["Look", png, "closely", result, "then this"])).toEqual([
      { type: "prompt", text: "Look\n\nclosely", media: [png] },
      result,
      { type: "prompt", text: "then this" },
    ]);
  });
});

describe("chat handles", () => {
  it("opens a chat and sends with its defaults", async () => {
    const { twigg, api } = setup();
    api.reply(json({ id: ids.chat, namespace: "acme" }, 201), sseResponse(textTurn("Hi!")));
    const chat = await twigg.chats.open({ namespace: "acme" }, { model: "claude-opus-5" });
    expect(chat.id).toBe(ids.chat);
    expect(chat.data?.namespace).toBe("acme");
    const reply = await chat.send("Hello", { max_tokens: 100 });
    expect(reply.text).toBe("Hi!");
    expect(api.last.body).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 100,
      input: [{ type: "prompt", text: "Hello" }],
    });
  });

  it("keeps stream options out of the request body", async () => {
    const { twigg, api } = setup();
    api.reply(sseResponse(textTurn()));
    await twigg.chat(ids.chat).send("Hi", { model: "m", recover: false, timeout: 5000 });
    expect(api.last.body).not.toHaveProperty("recover");
    expect(api.last.body).not.toHaveProperty("timeout");
  });

  it("opens a chat by external id and sends by its id", async () => {
    const { twigg, api } = setup();
    api.reply(json({ id: ids.chat, external_id: "+447700" }, 201), sseResponse(textTurn()));
    const chat = await twigg.chats.openByExternalId("+447700", { title: "Ann" }, { model: "m" });
    expect(api.last).toMatchObject({ method: "PUT", body: { title: "Ann" } });
    expect(api.last.url.pathname).toBe("/api/v1/chats/external/%2B447700");
    expect(chat.data?.external_id).toBe("+447700");
    await chat.send("Hi", { system: "Reply in Welsh.", wait_for_pending_tool_calls: 30 });
    expect(api.last.url.pathname).toBe(`/api/v1/chats/${ids.chat}/responses`);
    expect(api.last.body).toMatchObject({
      system: "Reply in Welsh.",
      wait_for_pending_tool_calls: 30,
    });
  });

  it("does not offer the non-streaming or by-external-id request fields", () => {
    const { twigg } = setup();
    const chat = twigg.chat(ids.chat);
    // @ts-expect-error The SDK always streams.
    void chat.stream("Hi", { model: "m", stream: false });
    // @ts-expect-error Only the by-external-id route takes `chat`.
    void chat.stream("Hi", { model: "m", chat: { title: "x" } });
  });
});

describe("namespace scope", () => {
  it("pins every call to its namespace", async () => {
    const { twigg, api } = setup();
    const scope = twigg.namespace("acme").child("support");
    await scope.chats.create({ title: "x" });
    expect(api.last.body).toEqual({ title: "x", namespace: "acme/support" });
    await scope.config.instructions.publish({ mode: "replace", body: "Be kind." });
    expect(api.last.body).toMatchObject({ namespace: "acme/support" });
    api.reply(json([]));
    await scope.config.budgets.versions({ model: ids.run });
    expect(api.last.url.searchParams.get("namespace")).toBe("acme/support");
    expect(api.last.url.searchParams.get("model")).toBe(ids.run);
    await scope.usage.query({ range: "7d" });
    expect(api.last.url.searchParams.get("namespace")).toBe("acme/support");
  });

  it("refuses a body that names another namespace", () => {
    const { twigg } = setup();
    expect(() => twigg.namespace("acme").chats.create({ namespace: "other" } as never)).toThrow(
      /pinned/,
    );
  });
});

describe("media", () => {
  it("encodes bytes as base64", () => {
    expect(media.fromBytes(new Uint8Array([104, 105]), "text/plain", "hi.txt")).toEqual({
      mime: "text/plain",
      data_base64: "aGk=",
      filename: "hi.txt",
    });
  });

  it("guesses MIME types from extensions and leading bytes", () => {
    expect(media.guessMime("chart.PNG")).toBe("image/png");
    expect(media.guessMime("blob", new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(
      "application/pdf",
    );
    expect(media.guessMime("blob", new Uint8Array([1, 2]))).toBeUndefined();
  });

  it("rejects a data URI passed as base64", () => {
    expect(() => media.fromBase64("data:image/png;base64,AAAA", "image/png")).toThrow(/prefix/);
  });

  it("checks attachments against a model's limits", () => {
    const model = {
      name: "m",
      media: {
        configured: true,
        max_attachments_per_part: 1,
        user: { mime_types: ["image/*"], max_bytes_per_attachment: 4 },
        tool_result: { mime_types: [], max_bytes_per_attachment: 0 },
        assistant: { mime_types: [], max_bytes_per_attachment: 0 },
      },
    };
    expect(media.check(model, [{ mime: "image/png", data_base64: "AAAA" }])).toEqual([]);
    const problems = media.check(model, [
      { mime: "application/pdf", data_base64: "AAAAAAAA", filename: "r.pdf" },
      { mime: "image/png", data_base64: "AAAA" },
    ]);
    expect(problems).toHaveLength(3);
  });

  it("turns stored prompts back into parts and refuses model output", () => {
    const stored = {
      id: "p1",
      ordinal: 1,
      role: "user",
      created_at: "",
      user_metadata: {},
      part: { type: "prompt" as const, text: "again" },
      media: [
        { media_id: "m1", mime: "image/png", byte_len: 3, data_base64: "AAAA", filename: "a.png" },
      ],
    };
    expect(media.toSubmittable(stored)).toEqual({
      type: "prompt",
      text: "again",
      media: [{ mime: "image/png", data_base64: "AAAA", filename: "a.png" }],
    });
    expect(() =>
      media.toSubmittable({ ...stored, role: "assistant", part: { type: "message", text: "hi" } }),
    ).toThrow(/written by the model/);
  });
});

describe("chats from listings and the default model", () => {
  it("turns a listed summary into a chat that sends with the client's model", async () => {
    const { MockTwigg, streamBuilder } = await import("../src/testing/index.js");
    const twigg = new MockTwigg({ model: "gpt-6-luna" }).respond(streamBuilder().text("hi").done());
    await twigg.chats.create({ namespace: "me", title: "Plans" });
    const [summary] = (await twigg.chats.list({ namespace: "me" })).data;
    if (!summary) throw new Error("no chat listed");
    const chat = twigg.chat(summary);
    expect(chat.id).toBe(summary.id);
    expect(chat.data).toBe(summary);
    expect((await chat.send("hello")).text).toBe("hi");
    expect(twigg.server.calls.at(-1)?.body).toMatchObject({ model: "gpt-6-luna" });
  });

  it("lets a chat's defaults and a call override the client's model", async () => {
    const { twigg, api } = setup({ model: "client-model" });
    api.reply(sseResponse(textTurn()), sseResponse(textTurn()));
    const chat = twigg.chat(ids.chat, { model: "chat-model" });
    await chat.send("a");
    expect(api.last.body).toMatchObject({ model: "chat-model" });
    await chat.send("b", { model: "call-model" });
    expect(api.last.body).toMatchObject({ model: "call-model" });
  });

  it("explains a turn with no model anywhere", () => {
    const { twigg, api } = setup();
    expect(() => twigg.chat(ids.chat).stream("hi")).toThrow(/No model/);
    expect(api.requests).toHaveLength(0);
  });
});
