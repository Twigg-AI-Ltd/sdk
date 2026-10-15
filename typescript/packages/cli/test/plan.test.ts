import { Twigg } from "@twigg/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/load.js";
import { apply, DriftError, plan } from "../src/plan.js";
import { context } from "../src/remote.js";
import { DEFAULTS, fakeApi, MODELS } from "./fake-api.js";
import { cli, project } from "./helpers.js";

const config = `version: 1
global:
  instructions: Be concise.
namespaces:
  acme:
    instructions:
      mode: append
      body: { $file: prompts/acme.md }
    tools:
      definitions:
        - $file: tools/read_file.json
        - name: search_docs
          description: Search the docs
          input_schema: { type: object, properties: { q: { type: string } } }
    budgets:
      default: { version: 3, headroom: 0.2 }
      claude-opus-5: { version: 3, headroom: 0.15, max_history_tokens: 200000 }
  acme/support:
    instructions:
      mode: replace
      body: You are support.
`;

const files = {
  "twigg.config.yaml": config,
  "prompts/acme.md": "You work for Acme.\n",
  "tools/read_file.json": JSON.stringify({ name: "read_file", input_schema: { type: "object" } }),
};

describe("plan and apply", () => {
  it("tells the organisation-wide scope apart from a namespace named global", async () => {
    const api = fakeApi();
    const dir = await project({
      "twigg.config.yaml":
        "version: 1\nglobal:\n  instructions: Org.\nnamespaces:\n  global:\n    instructions: Ns.\n",
    });
    const result = await cli(api, dir, ["config", "plan"]);
    expect(result.stdout).toContain("(organisation)\n  + instructions");
    expect(result.stdout).toContain("\nglobal\n  + instructions");
  });

  it("plans everything as new against an empty organisation", async () => {
    const api = fakeApi();
    const dir = await project(files);
    const result = await cli(api, dir, ["config", "plan"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // Exit 2 for changes only when asked, so a CI step can fail on drift.
    expect((await cli(api, dir, ["config", "plan", "--detailed-exitcode"])).code).toBe(2);
    expect(result.stdout).toContain("(organisation)\n  + instructions");
    expect(result.stdout).toContain("+ tools         read_file, search_docs (append)");
    expect(result.stdout).toContain("+ budgets       claude-opus-5: new");
    expect(result.stdout).toContain("Plan: 6 to publish, 0 to withdraw, 0 unchanged.");
    expect(api.writes()).toEqual([]);
  });

  it("applies parents before children, then plans no changes", async () => {
    const api = fakeApi();
    const dir = await project(files);
    const applied = await cli(api, dir, ["config", "apply", "--yes", "--report", "report.json"]);
    expect(applied.code).toBe(0);
    expect(api.writes()).toEqual([
      "POST /api/v1/config/instructions",
      "POST /api/v1/config/instructions acme",
      "POST /api/v1/config/tools acme",
      "POST /api/v1/config/budgets acme",
      "POST /api/v1/config/budgets acme",
      "POST /api/v1/config/instructions acme/support",
    ]);
    const budget = api.calls.find(
      (c) =>
        c.method === "POST" &&
        c.path.endsWith("budgets") &&
        (c.body as { model_ids: string[] }).model_ids.length,
    );
    expect(budget?.body).toMatchObject({ model_ids: [MODELS[0]?.id] });
    expect(api.active("instructions", "acme")[0]?.body).toBe("You work for Acme.\n");
    const again = await cli(api, dir, ["config", "plan"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Plan: 0 to publish, 0 to withdraw, 6 unchanged.");
  });

  it("writes a report of what was applied", async () => {
    const api = fakeApi();
    const dir = await project(files);
    await cli(api, dir, ["config", "apply", "--yes", "--report", "report.json"]);
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(`${dir}/report.json`, "utf8"));
    expect(report.applied).toHaveLength(6);
    expect(report.applied[0]).toMatchObject({
      scope: null,
      surface: "instructions",
      action: "publish",
    });
  });

  it("refuses to apply without --yes when there is no terminal", async () => {
    const api = fakeApi();
    const dir = await project(files);
    const result = await cli(api, dir, ["config", "apply"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(api.writes()).toEqual([]);
  });

  it("asks before applying in a terminal, and stops on no", async () => {
    const api = fakeApi();
    const dir = await project(files);
    const result = await cli(api, dir, ["config", "apply"], { confirm: async () => false });
    expect(result.code).toBe(1);
    expect(api.writes()).toEqual([]);
  });
});

describe("normalisation", () => {
  it("does not flap on line endings, key order, null fields or omitted defaults", async () => {
    const api = fakeApi();
    api.add("instructions", "acme", { mode: "append", body: "Line one\r\nLine two\n\n  " });
    api.add("tools", "acme", {
      mode: "append",
      definitions: [
        {
          name: "search_docs",
          description: null,
          strict: null,
          input_schema: { properties: { q: { type: "string" } }, type: "object" },
        },
        { name: "read_file", description: null, input_schema: { type: "object" } },
      ],
    });
    api.add("budgets", "acme", { model_id: null, budget: { ...DEFAULTS.budget, headroom: 0.2 } });
    api.add("retention", "acme", { rules: DEFAULTS.retention });
    const dir = await project({
      "twigg.config.yaml": `version: 1
namespaces:
  acme:
    instructions: "Line one\\nLine two"
    tools:
      definitions:
        - name: read_file
          input_schema: { type: object }
        - name: search_docs
          input_schema: { type: object, properties: { q: { type: string } } }
    budgets:
      default: { version: 3, headroom: 0.2 }
    retention: { version: 3, anchor_parts: 0 }
`,
    });
    const result = await cli(api, dir, ["config", "plan"]);
    expect(result.stdout).toContain("Plan: 0 to publish, 0 to withdraw, 4 unchanged.");
    expect(result.code).toBe(0);
  });

  it("counts a mode change as a change", async () => {
    const api = fakeApi();
    api.add("instructions", "acme", { mode: "append", body: "Hi" });
    const dir = await project({
      "twigg.config.yaml":
        "version: 1\nnamespaces:\n  acme:\n    instructions: { mode: replace, body: Hi }\n",
    });
    const result = await cli(api, dir, ["config", "plan", "--detailed-exitcode"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("append -> replace");
  });
});

describe("withdrawals and the subtree", () => {
  it("withdraws a surface set to null and budgets left out of the map", async () => {
    const api = fakeApi();
    api.add("tools", "acme", { mode: "append", definitions: [] });
    api.add("budgets", "acme", { model_id: MODELS[1]?.id, budget: DEFAULTS.budget });
    const dir = await project({
      "twigg.config.yaml": "version: 1\nnamespaces:\n  acme:\n    tools: null\n    budgets: {}\n",
    });
    const result = await cli(api, dir, ["config", "apply", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("- budgets       gpt-5-6-luna: withdraw v1");
    expect(api.writes()).toEqual([
      "DELETE /api/v1/config/tools/active acme",
      "DELETE /api/v1/config/budgets/active acme",
    ]);
    expect(api.calls.at(-1)?.query.model).toBe(MODELS[1]?.id);
  });

  it("shows unmanaged overrides beneath the scope and leaves the rest alone", async () => {
    const api = fakeApi();
    api.add("instructions", "acme/support", { mode: "replace", body: "Support." });
    api.add("instructions", null, { mode: null, body: "Global." });
    api.add("instructions", "other", { mode: "append", body: "Other." });
    const dir = await project({
      "twigg.config.yaml": "version: 1\nnamespaces:\n  acme:\n    instructions: Acme.\n",
    });
    const result = await cli(api, dir, ["config", "plan", "--scope", "acme"]);
    expect(result.stdout).toContain(
      "acme/support   (unmanaged)\n  ! instructions  replace v1, shadows acme",
    );
    expect(result.stdout).not.toContain("global");
    expect(result.stdout).not.toContain("other");
    expect(result.stdout).toContain("1 unmanaged");
  });

  it("prunes the whole organisation only with --prune-all", async () => {
    const api = fakeApi();
    api.add("instructions", "other", { mode: "append", body: "Other." });
    const dir = await project({
      "twigg.config.yaml": "version: 1\nnamespaces:\n  acme:\n    instructions: Acme.\n",
    });
    const bare = await cli(api, dir, ["config", "apply", "--prune", "--yes"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("--prune without --scope");
    const both = await cli(api, dir, ["config", "plan", "--prune-all", "--scope", "acme"]);
    expect(both.code).toBe(1);
    expect(api.writes()).toEqual([]);

    const all = await cli(api, dir, ["config", "plan", "--prune-all"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("other   (not in the file: pruning withdraws all of it)");
  });

  it("withdraws unmanaged overrides with --prune", async () => {
    const api = fakeApi();
    api.add("instructions", "acme/support", { mode: "replace", body: "Support." });
    api.add("budgets", "acme/support", { model_id: null, budget: DEFAULTS.budget });
    const dir = await project({
      "twigg.config.yaml": "version: 1\nnamespaces:\n  acme:\n    instructions: Acme.\n",
    });
    const result = await cli(api, dir, ["config", "apply", "--scope", "acme", "--prune", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "acme/support   (not in the file: pruning withdraws all of it)",
    );
    expect(result.stdout).toContain("2 to withdraw (2 pruned)");
    expect(api.writes()).toEqual([
      "POST /api/v1/config/instructions acme",
      "DELETE /api/v1/config/instructions/active acme/support",
      "DELETE /api/v1/config/budgets/active acme/support",
    ]);
  });

  it("rejects an unknown model in budgets", async () => {
    const api = fakeApi();
    const dir = await project({
      "twigg.config.yaml":
        "version: 1\nnamespaces:\n  acme:\n    budgets:\n      no-such-model: { version: 3, headroom: 0.1 }\n",
    });
    const result = await cli(api, dir, ["config", "plan"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown model "no-such-model"');
  });
});

describe("the race guard", () => {
  it("stops before a change whose active version moved since the plan", async () => {
    const api = fakeApi();
    const dir = await project({
      "twigg.config.yaml":
        "version: 1\nglobal:\n  instructions: Mine.\nnamespaces:\n  acme:\n    instructions: Also mine.\n",
    });
    const twigg = new Twigg({ apiKey: "tw_test", fetch: api.fetch });
    const ctx = await context(twigg);
    const loaded = await loadConfig(`${dir}/twigg.config.yaml`, {});
    const planned = await plan(ctx, loaded.desired);
    // Someone publishes acme's instructions in the console after the plan was read.
    api.add("instructions", "acme", { mode: "append", body: "Theirs." });
    const failure = await apply(ctx, planned).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DriftError);
    expect((failure as DriftError).applied.map((a) => a.scope)).toEqual([null]);
    expect(api.active("instructions", "acme")[0]?.body).toBe("Theirs.");
  });
});

describe("rollback and history", () => {
  it("points out when a change matches an earlier version", async () => {
    const api = fakeApi();
    api.add("instructions", "acme", { mode: "append", body: "Old rules." });
    api.add("instructions", "acme", { mode: "append", body: "New rules." });
    const dir = await project({
      "twigg.config.yaml": "version: 1\nnamespaces:\n  acme:\n    instructions: Old rules.\n",
    });
    const result = await cli(api, dir, ["config", "plan"]);
    expect(result.stdout).toContain(
      "same as v1: `twigg config rollback --scope acme --surface instructions --to 1` restores it",
    );
    const json = JSON.parse((await cli(api, dir, ["config", "plan", "--json"])).stdout);
    expect(json.changes[0]).toMatchObject({
      surface: "instructions",
      action: "publish",
      matches: 1,
    });
  });

  it("restores the previous version, or the one named", async () => {
    const api = fakeApi();
    api.add("tools", "acme", { mode: "append", definitions: [] });
    api.add("tools", "acme", { mode: "append", definitions: [] });
    api.add("tools", "acme", { mode: "append", definitions: [] });
    const dir = await project();
    const back = await cli(api, dir, [
      "config",
      "rollback",
      "--scope",
      "acme",
      "--surface",
      "tools",
    ]);
    expect(back.code).toBe(0);
    expect(back.stdout).toBe("Restored tools in acme to v2 (was v3).");
    const to = await cli(api, dir, [
      "config",
      "rollback",
      "--scope",
      "acme",
      "--surface",
      "tools",
      "--to",
      "1",
    ]);
    expect(to.stdout).toBe("Restored tools in acme to v1 (was v2).");
    expect(api.active("tools", "acme")[0]?.version).toBe(1);
  });

  it("rolls back one model's budget", async () => {
    const api = fakeApi();
    api.add("budgets", null, { model_id: MODELS[0]?.id, budget: DEFAULTS.budget });
    api.add("budgets", null, { model_id: MODELS[0]?.id, budget: DEFAULTS.budget });
    api.add("budgets", null, { model_id: null, budget: DEFAULTS.budget });
    const dir = await project();
    const result = await cli(api, dir, [
      "config",
      "rollback",
      "--surface",
      "budgets",
      "--model",
      "claude-opus-5",
    ]);
    expect(result.stdout).toBe("Restored budgets in (organisation) to v1 (was v2).");
  });

  it("lists versions with the active one marked", async () => {
    const api = fakeApi();
    api.add("instructions", "acme", { mode: "append", body: "a" });
    api.add("instructions", "acme", { mode: "replace", body: "b" });
    const dir = await project();
    const result = await cli(api, dir, [
      "config",
      "history",
      "--scope",
      "acme",
      "--surface",
      "instructions",
    ]);
    expect(result.stdout).toMatch(/\* v2 .* replace/);
    expect(result.stdout).toMatch(/ {3}v1 .* append/);
  });

  it("explains a rollback with nothing to go back to", async () => {
    const api = fakeApi();
    api.add("retention", null, { rules: DEFAULTS.retention });
    const dir = await project();
    const result = await cli(api, dir, ["config", "rollback", "--surface", "retention"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no version before v1");
  });
});
