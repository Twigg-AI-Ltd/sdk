// Updating chats, listing their runs, deleting by namespace prefix, usage totals and client_data.
import { describe, expect, it } from "vitest";
import { MockTwigg, streamBuilder } from "../src/testing/index.js";
import { apiError, ids, json, setup } from "./helpers.js";

const run = (id: string) => ({ id, origin: "customer", status: "succeeded", model: "m" });

describe("updating a chat", () => {
  it("sends only the fields given, nulls included, as a PATCH", async () => {
    const { twigg, api } = setup();
    api.reply(json({ id: ids.chat, title: "Renamed" }));
    const chat = await twigg.chats.update(ids.chat, {
      title: "Renamed",
      description: null,
      user_metadata: { tier: "gold", stale: null },
    });
    expect(chat.title).toBe("Renamed");
    expect(api.last.method).toBe("PATCH");
    expect(api.last.url.pathname).toBe(`/api/v1/chats/${ids.chat}`);
    expect(api.last.body).toEqual({
      title: "Renamed",
      description: null,
      user_metadata: { tier: "gold", stale: null },
    });
  });

  it("is retried like other idempotent calls", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(503, "unavailable"), json({ id: ids.chat }));
    await twigg.chats.update(ids.chat, { title: "x" });
    expect(api.requests.map((r) => r.method)).toEqual(["PATCH", "PATCH"]);
  });

  it("works from both kinds of chat handle", async () => {
    const { twigg, api } = setup();
    await twigg.chat(ids.chat).update({ title: "a" });
    expect(api.last.url.pathname).toBe(`/api/v1/chats/${ids.chat}`);
    await twigg.chatByExternalId("+447700").update({ title: "b" });
    expect(api.last.url.pathname).toBe("/api/v1/chats/external/%2B447700");
    await twigg.chats.updateByExternalId("wa:1", { title: "c" });
    expect(api.last.url.pathname).toBe("/api/v1/chats/external/wa%3A1");
  });
});

describe("usage on a chat", () => {
  it("asks for it with include=usage, and not otherwise", async () => {
    const { twigg, api } = setup();
    await twigg.chats.get(ids.chat);
    expect(api.last.url.search).toBe("");
    await twigg.chats.get(ids.chat, { include: "usage" });
    expect(api.last.url.searchParams.get("include")).toBe("usage");
    await twigg.chat(ids.chat).get({ include: "usage" });
    expect(api.last.url.searchParams.get("include")).toBe("usage");
    await twigg.chats.getByExternalId("wa:1", { include: "usage" });
    expect(api.last.url.searchParams.get("include")).toBe("usage");
  });
});

describe("a chat's runs", () => {
  it("iterates every run, paging older with after_id", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [run("r4"), run("r3")], first_id: "r4", last_id: "r3", has_more: true }),
      json({ data: [run("r2")], first_id: "r2", last_id: "r2", has_more: false }),
    );
    const seen: string[] = [];
    for await (const r of twigg.chat(ids.chat).runs({ limit: 2 })) seen.push(r.id);
    expect(seen).toEqual(["r4", "r3", "r2"]);
    expect(api.requests[0]?.url.pathname).toBe(`/api/v1/chats/${ids.chat}/runs`);
    expect(api.requests[1]?.url.searchParams.get("after_id")).toBe("r3");
    expect(api.requests[1]?.url.searchParams.get("limit")).toBe("2");
  });

  it("pages newer with before_id and yields oldest first", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [run("r6"), run("r5")], first_id: "r6", last_id: "r5", has_more: true }),
      json({ data: [run("r7")], first_id: "r7", last_id: "r7", has_more: false }),
    );
    const seen: string[] = [];
    for await (const r of twigg.chats.runsByExternalId("wa:1", { before_id: "r4" }))
      seen.push(r.id);
    expect(seen).toEqual(["r5", "r6", "r7"]);
    expect(api.requests[1]?.url.searchParams.get("before_id")).toBe("r6");
    expect(api.requests[1]?.url.searchParams.has("after_id")).toBe(false);
  });
});

describe("deleting by namespace prefix", () => {
  it("deletes chats and configuration under a prefix", async () => {
    const { twigg, api } = setup();
    api.reply(json({ deleted: 3 }));
    expect(await twigg.chats.deleteByNamespace("swarm/run-abc")).toEqual({ deleted: 3 });
    expect(api.last.method).toBe("DELETE");
    expect(api.last.url.pathname).toBe("/api/v1/chats");
    expect(api.last.url.searchParams.get("namespace_prefix")).toBe("swarm/run-abc");
    await twigg.config.delete("swarm/run-abc");
    expect(api.last.method).toBe("DELETE");
    expect(api.last.url.pathname).toBe("/api/v1/config");
    expect(api.last.url.searchParams.get("namespace_prefix")).toBe("swarm/run-abc");
  });

  it("scopes do it for their own namespace", async () => {
    const { twigg, api } = setup();
    const scope = twigg.namespace("swarm").child("run-abc");
    await scope.chats.deleteAll();
    expect(api.last.url.pathname).toBe("/api/v1/chats");
    expect(api.last.url.searchParams.get("namespace_prefix")).toBe("swarm/run-abc");
    await scope.config.delete();
    expect(api.last.url.pathname).toBe("/api/v1/config");
    expect(api.last.url.searchParams.get("namespace_prefix")).toBe("swarm/run-abc");
  });
});

describe("client_data", () => {
  it("goes out on a ready-made part, and history asks for it back", async () => {
    const { twigg, api } = setup();
    api.reply(json({ data: [], first_ordinal: null, last_ordinal: null, has_more: false }));
    await twigg.chat(ids.chat).history({ include_client_data: true });
    expect(api.last.url.searchParams.get("include_client_data")).toBe("true");
  });
});

describe("MockTwigg chat management", () => {
  it("updates a chat as the API does", async () => {
    const twigg = new MockTwigg();
    const chat = await twigg.chats.open({ title: "Old", user_metadata: { a: 1, b: 2 } });
    const updated = await chat.update({ title: "", user_metadata: { b: null, c: 3 } });
    expect(updated.title).toBeNull();
    expect(updated.user_metadata).toEqual({ a: 1, c: 3 });
    expect((await chat.get()).user_metadata).toEqual({ a: 1, c: 3 });
    await expect(chat.update({ namespace: "x" } as never)).rejects.toMatchObject({ status: 422 });
  });

  it("lists runs and sums usage", async () => {
    const twigg = new MockTwigg();
    twigg.respond(
      streamBuilder().text("one").done({ cost: "0.01" }),
      streamBuilder().text("two").done({ cost: "0.02" }),
    );
    const chat = await twigg.chats.open({}, { model: "m" });
    const first = await chat.send("a");
    const second = await chat.send("b");
    const runs: string[] = [];
    for await (const r of chat.runs()) runs.push(r.id);
    expect(runs).toEqual([second.runId, first.runId]);
    expect((await chat.get()).usage).toBeUndefined();
    const usage = (await chat.get({ include: "usage" })).usage;
    expect(usage).toMatchObject({ runs: 2, unsettled_runs: 0, cost: "0.03" });
  });

  it("deletes a namespace subtree by path segment", async () => {
    const twigg = new MockTwigg();
    await twigg.chats.create({ namespace: "swarm/run-abc" });
    await twigg.chats.create({ namespace: "swarm/run-abc/agent-1" });
    await twigg.chats.create({ namespace: "swarm/run-abcd" });
    expect(await twigg.namespace("swarm/run-abc").chats.deleteAll()).toEqual({ deleted: 2 });
    const left: (string | null | undefined)[] = [];
    for await (const c of twigg.chats.list()) left.push(c.namespace);
    expect(left).toEqual(["swarm/run-abcd"]);
  });

  it("keeps client_data beside a part and returns it only when asked", async () => {
    const twigg = new MockTwigg();
    twigg.respond(streamBuilder().text("ok").done());
    const chat = await twigg.chats.open({}, { model: "m" });
    await chat.send({ type: "prompt", text: "hi", client_data: { ui: "msg-7" } });
    const plain = await chat.history();
    expect(plain.data[0]).not.toHaveProperty("client_data");
    const withData = await chat.history({ include_client_data: true });
    expect(withData.data[0]?.client_data).toEqual({ ui: "msg-7" });
    expect(withData.data[1]).not.toHaveProperty("client_data");
  });
});
