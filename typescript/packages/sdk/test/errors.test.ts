import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
  TwiggError,
  ValidationError,
} from "../src/index.js";
import { json, setup } from "./helpers.js";

describe("error mapping", () => {
  it.each([
    [401, "unauthorized", AuthenticationError],
    [402, "payment_required", InsufficientBalanceError],
    [404, "not_found", NotFoundError],
    [409, "conflict", ConflictError],
    [422, "validation_error", ValidationError],
  ])("maps %i to its class", async (status, code, Class) => {
    const { twigg, api } = setup();
    api.reply(json({ error: { code, message: "nope" } }, status));
    const error = await twigg.chats.get("chat-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Class);
    expect(error).toBeInstanceOf(TwiggError);
    expect(error).toMatchObject({ status, code, message: "nope" });
  });

  it("keeps the envelope's hint and details", async () => {
    const { twigg, api } = setup();
    api.reply(
      json(
        {
          error: {
            code: "validation_error",
            message: "bad field",
            hint: "https://api.twigg.ai/",
            details: { field: "namespace" },
          },
        },
        422,
      ),
    );
    const error = (await twigg.chats.create().catch((e: unknown) => e)) as TwiggError;
    expect(error.hint).toBe("https://api.twigg.ai/");
    expect(error.details).toEqual({ field: "namespace" });
  });

  it("falls back to the body text when a proxy answers", async () => {
    const { twigg, api } = setup({ maxRetries: 0 });
    api.reply(new Response("upstream connect error", { status: 504, statusText: "Gateway" }));
    const error = (await twigg.models.list().catch((e: unknown) => e)) as TwiggError;
    expect(error.constructor).toBe(TwiggError);
    expect(error).toMatchObject({
      status: 504,
      code: "http_504",
      message: "upstream connect error",
    });
  });
});
