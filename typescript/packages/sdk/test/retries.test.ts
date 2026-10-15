import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
} from "../src/index.js";
import { apiError, json, setup } from "./helpers.js";

describe("retries", () => {
  it("retries a read after a 503 and succeeds", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(503, "unavailable"), json([]));
    await expect(twigg.models.list()).resolves.toEqual([]);
    expect(api.requests).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const { twigg, api } = setup({ maxRetries: 1 });
    api.reply(apiError(503, "unavailable"), apiError(503, "unavailable"), json([]));
    await expect(twigg.models.list()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(api.requests).toHaveLength(2);
  });

  it("does not retry a publish after a 5xx: a second attempt would be a second version", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(502, "external_service_error"));
    await expect(
      twigg.config.instructions.publish({ mode: "append", body: "Be brief." }),
    ).rejects.toThrow();
    expect(api.requests).toHaveLength(1);
  });

  it("retries a publish after a 429, which is rejected before anything happens", async () => {
    const { twigg, api } = setup();
    api.reply(apiError(429, "rate_limited"), json({ id: "v2" }));
    await expect(
      twigg.config.instructions.publish({ mode: "append", body: "Be brief." }),
    ).resolves.toEqual({ id: "v2" });
    expect(api.requests).toHaveLength(2);
  });

  it("honours Retry-After in seconds", async () => {
    const { twigg, api, sleeps } = setup();
    api.reply(
      json({ error: { code: "rate_limited", message: "slow" } }, 429, { "retry-after": "3" }),
    );
    await twigg.models.list();
    expect(sleeps).toEqual([3000]);
  });

  it("backs off exponentially without Retry-After", async () => {
    const { twigg, api, sleeps } = setup();
    api.reply(apiError(503, "unavailable"), apiError(503, "unavailable"));
    await twigg.models.list();
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it("retries a read after a network error", async () => {
    const { twigg, api } = setup();
    api.reply(new TypeError("fetch failed"), json([]));
    await expect(twigg.models.list()).resolves.toEqual([]);
  });

  it("reports a network error as ConnectionError once retries run out", async () => {
    const { twigg, api } = setup({ maxRetries: 0 });
    api.reply(new TypeError("fetch failed"));
    await expect(twigg.models.list()).rejects.toBeInstanceOf(ConnectionError);
  });

  it("reports RateLimitError once retries run out", async () => {
    const { twigg, api } = setup({ maxRetries: 0 });
    api.reply(apiError(429, "rate_limited"));
    await expect(twigg.models.list()).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("timeouts and cancellation", () => {
  const hang = (_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("times out an attempt and reports TimeoutError", async () => {
    const { twigg } = setup({ fetch: hang as typeof fetch, timeout: 10, maxRetries: 0 });
    await expect(twigg.models.list()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("rethrows the caller's abort reason without retrying", async () => {
    let calls = 0;
    const counting = (input: unknown, init?: RequestInit) => {
      calls++;
      return hang(input, init);
    };
    const { twigg } = setup({ fetch: counting as typeof fetch });
    const controller = new AbortController();
    const pending = twigg.models.list({ signal: controller.signal });
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
    expect(calls).toBe(1);
  });
});

describe("settlement", () => {
  it("polls a run until its cost lands", async () => {
    const { twigg, api, sleeps } = setup();
    const run = { id: "r1", status: "succeeded", cost: null, settled_at: null };
    api.reply(
      json(run),
      json(run),
      json({ ...run, cost: "0.002", settled_at: "2026-10-14T10:00:00Z" }),
    );
    const settled = await twigg.runs.waitForSettlement("r1");
    expect(settled.cost).toBe("0.002");
    expect(sleeps).toEqual([1000, 2000]);
  });
});
