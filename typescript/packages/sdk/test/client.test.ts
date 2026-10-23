import { afterEach, describe, expect, it, vi } from "vitest";
import { Twigg, TwiggError } from "../src/index.js";
import { fakeFetch, json, setup } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authentication", () => {
  it("sends the API key as a bearer token", async () => {
    const { twigg, api } = setup();
    await twigg.runs.get("run-1");
    expect(api.last.headers.authorization).toBe("Bearer tw_test");
  });

  it("reads the key and base URL from the environment", async () => {
    vi.stubEnv("TWIGG_API_KEY", "tw_env");
    vi.stubEnv("TWIGG_BASE_URL", "https://env.test");
    const api = fakeFetch();
    await new Twigg({ fetch: api.fetch }).models.list();
    expect(api.last.headers.authorization).toBe("Bearer tw_env");
    expect(api.last.url.origin).toBe("https://env.test");
  });

  it("fails before sending when an authenticated call has no key", async () => {
    vi.stubEnv("TWIGG_API_KEY", "");
    const { twigg, api } = setup({ apiKey: undefined });
    const error = await twigg.chats.create().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwiggError);
    expect((error as TwiggError).code).toBe("missing_api_key");
    expect(api.requests).toHaveLength(0);
  });

  it("calls public endpoints without a key", async () => {
    vi.stubEnv("TWIGG_API_KEY", "");
    const { twigg, api } = setup({ apiKey: undefined });
    api.reply(json({ models: [], markup_percent: "0", organisation_specific: false }));
    await twigg.catalogue.list();
    expect(api.last.headers.authorization).toBeUndefined();
  });
});

describe("requests", () => {
  it("keeps a path prefix on the base URL", async () => {
    const { twigg, api } = setup({ baseURL: "https://proxy.test/twigg/" });
    await twigg.runs.get("run-1");
    expect(api.last.url.href).toBe("https://proxy.test/twigg/api/v1/runs/run-1");
  });

  it("percent-encodes path parameters", async () => {
    const { twigg, api } = setup();
    await twigg.chats.get("a/b?c");
    expect(api.last.url.pathname).toBe("/api/v1/chats/a%2Fb%3Fc");
  });

  it("refuses dot segments that URL parsing would resolve to another path", async () => {
    const { twigg, api } = setup();
    await expect(twigg.catalogue.get("../../api/v1/usage")).rejects.toThrow("Invalid path");
    await expect(twigg.chats.get("..")).rejects.toThrow("Invalid path");
    await expect(twigg.chats.get("")).rejects.toThrow("Invalid path");
    expect(api.requests).toHaveLength(0);
  });

  it("merges client and per-call headers", async () => {
    const { twigg, api } = setup({ headers: { "x-team": "billing" } });
    await twigg.models.list({ headers: { "x-trace": "abc" } });
    expect(api.last.headers["x-team"]).toBe("billing");
    expect(api.last.headers["x-trace"]).toBe("abc");
  });

  it("returns undefined for an empty 204", async () => {
    const { twigg, api } = setup();
    api.reply(new Response(null, { status: 204 }));
    await expect(twigg.chats.delete("chat-1")).resolves.toBeUndefined();
  });

  it("returns Markdown as text", async () => {
    const { twigg, api } = setup();
    api.reply(
      new Response("| model |", { headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    await expect(twigg.catalogue.markdown()).resolves.toBe("| model |");
    expect(api.last.headers.accept).toBe("text/plain");
  });
});
