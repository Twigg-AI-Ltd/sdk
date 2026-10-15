import { describe, expect, it } from "vitest";
import { json, setup } from "./helpers.js";

const chat = (id: string) => ({ id, created_at: "2026-10-14T00:00:00Z" });
const part = (ordinal: number) => ({ id: `p${ordinal}`, ordinal });

describe("chat listing", () => {
  it("iterates every chat, paging older with after_id", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [chat("c4"), chat("c3")], first_id: "c4", last_id: "c3", has_more: true }),
      json({ data: [chat("c2"), chat("c1")], first_id: "c2", last_id: "c1", has_more: false }),
    );
    const ids: string[] = [];
    for await (const c of twigg.chats.list({ namespace: "acme", limit: 2 })) ids.push(c.id);
    expect(ids).toEqual(["c4", "c3", "c2", "c1"]);
    expect(api.requests[1]?.url.searchParams.get("after_id")).toBe("c3");
    expect(api.requests[1]?.url.searchParams.get("namespace")).toBe("acme");
    expect(api.requests[1]?.url.searchParams.has("before_id")).toBe(false);
  });

  it("pages newer with before_id and yields oldest first", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [chat("c6"), chat("c5")], first_id: "c6", last_id: "c5", has_more: true }),
      json({ data: [chat("c8"), chat("c7")], first_id: "c8", last_id: "c7", has_more: false }),
    );
    const ids: string[] = [];
    for await (const c of twigg.chats.list({ before_id: "c4" })) ids.push(c.id);
    expect(ids).toEqual(["c5", "c6", "c7", "c8"]);
    expect(api.requests[1]?.url.searchParams.get("before_id")).toBe("c6");
  });

  it("awaits to one page with manual paging", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [chat("c2")], first_id: "c2", last_id: "c2", has_more: true }),
      json({ data: [chat("c1")], first_id: "c1", last_id: "c1", has_more: false }),
    );
    const page = await twigg.chats.list();
    expect(page.data.map((c) => c.id)).toEqual(["c2"]);
    const next = await page.nextPage();
    expect(next?.data.map((c) => c.id)).toEqual(["c1"]);
    expect(await next?.nextPage()).toBeNull();
  });

  it("fetches nothing until awaited or iterated", async () => {
    const { twigg, api } = setup();
    const pending = twigg.chats.list();
    expect(api.requests).toHaveLength(0);
    api.reply(json({ data: [], first_id: null, last_id: null, has_more: false }));
    await pending;
    expect(api.requests).toHaveLength(1);
  });
});

describe("history", () => {
  it("walks backwards from the newest page, yielding newest first", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [part(3), part(4)], first_ordinal: 3, last_ordinal: 4, has_more: true }),
      json({ data: [part(1), part(2)], first_ordinal: 1, last_ordinal: 2, has_more: false }),
    );
    const ordinals: number[] = [];
    for await (const p of twigg.chats.history("chat-1", { limit: 2 })) ordinals.push(p.ordinal);
    expect(ordinals).toEqual([4, 3, 2, 1]);
    expect(api.requests[1]?.url.searchParams.get("before_ordinal")).toBe("3");
  });

  it("pages forwards from after_ordinal, yielding oldest first", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [part(5), part(6)], first_ordinal: 5, last_ordinal: 6, has_more: true }),
      json({ data: [part(7)], first_ordinal: 7, last_ordinal: 7, has_more: false }),
    );
    const ordinals: number[] = [];
    for await (const p of twigg.chats.history("chat-1", { after_ordinal: 4 }))
      ordinals.push(p.ordinal);
    expect(ordinals).toEqual([5, 6, 7]);
    expect(api.requests[1]?.url.searchParams.get("after_ordinal")).toBe("6");
    expect(api.requests[1]?.url.searchParams.has("before_ordinal")).toBe(false);
  });

  it("exposes the page's ordinals and keeps include on every page", async () => {
    const { twigg, api } = setup();
    api.reply(
      json({ data: [part(9)], first_ordinal: 9, last_ordinal: 9, has_more: true }),
      json({ data: [], first_ordinal: null, last_ordinal: null, has_more: false }),
    );
    const page = await twigg.chats.history("chat-1", { include: "full" });
    expect([page.firstOrdinal, page.lastOrdinal]).toEqual([9, 9]);
    await page.nextPage();
    expect(api.requests[1]?.url.searchParams.get("include")).toBe("full");
  });
});
