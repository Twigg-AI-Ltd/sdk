import { describe, expect, expectTypeOf, it } from "vitest";
import type { UsageReport } from "../src/index.js";
import { json, setup } from "./helpers.js";

describe("usage.query", () => {
  it("types each row's group by the dimension asked for", async () => {
    const { twigg, api } = setup();
    const row = { group: { dimension: "model", model_id: null, model_name: "gpt-6-luna" } };
    api.reply(json({ rows: [row] }), json({ rows: [row] }));

    const byModel = await twigg.usage.query({ range: "24h", group_by: "model" });
    expect(byModel.rows[0]?.group.model_name).toBe("gpt-6-luna");
    expectTypeOf(byModel.rows[0]!.group.model_name).toEqualTypeOf<string | null | undefined>();

    const scoped = await twigg.namespace("acme").usage.query({ range: "24h", group_by: "model" });
    expectTypeOf(scoped).toEqualTypeOf<UsageReport<"model">>();
    expectTypeOf<UsageReport<undefined>["rows"][number]["group"]>().toEqualTypeOf<null>();
  });
});
