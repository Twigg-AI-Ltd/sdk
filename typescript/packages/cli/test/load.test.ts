// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write ${VAR} placeholders on purpose.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIni, resolveCredentials } from "../src/credentials.js";
import { loadConfig } from "../src/load.js";
import { SCHEMA_PATH, validate } from "../src/schema.js";
import { DEFAULTS, fakeApi } from "./fake-api.js";
import { cli, project, read } from "./helpers.js";

describe("the schema", () => {
  it("is the same file as the pinned spec/config.v1.json", () => {
    const pinned = readFileSync(
      resolve(import.meta.dirname, "../../../../spec/config.v1.json"),
      "utf8",
    );
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(pinned);
  });

  it("reports readable problems", () => {
    expect(validate({ version: 1 })).toEqual([]);
    const problems = validate({ version: 1, namespaces: { Acme: {} }, extra: true });
    expect(problems.join("\n")).toMatch(/Acme/);
    expect(problems.join("\n")).toMatch(/extra/);
  });

  it("reports one line per mistake, not every anyOf alternative", () => {
    const budget = { version: 3, headroom: 0.2, history_mode: "adaptive" };
    expect(validate({ version: 1, global: { budgets: { default: budget } } })).toEqual([
      '/global/budgets/default/history_mode: must be equal to one of the allowed values ("summarize", "drop_oldest")',
    ]);
    expect(
      validate({
        version: 1,
        global: { budgets: { default: { ...budget, history_mode: "summarize", extra: 1 } } },
      }),
    ).toEqual(["/global/budgets/default (extra): must NOT have additional properties"]);
    expect(validate({ version: 1, global: { retention: { $file: 3 } } })).toEqual([
      "/global/retention/$file: must be string",
    ]);
  });
});

describe("loading", () => {
  it("interpolates only TWIGG_VAR_ variables", async () => {
    const { interpolate } = await import("../src/load.js");
    const env = { TWIGG_API_KEY: "tw_secret", TWIGG_VAR_STAGE: "staging" };
    expect(interpolate({ a: ["${TWIGG_VAR_STAGE}", "$${TWIGG_API_KEY}"] }, env)).toEqual({
      a: ["staging", "${TWIGG_API_KEY}"],
    });
    expect(() => interpolate("${TWIGG_API_KEY}", env)).toThrow("only variables named TWIGG_VAR_*");
    expect(() => interpolate("${HOME}", env)).toThrow("TWIGG_VAR_");
  });

  it("loads YAML with $file references and ${TWIGG_VAR_*} interpolation", async () => {
    const dir = await project({
      "twigg.config.yaml": `version: 1
global:
  instructions: { $file: "prompts/\${TWIGG_VAR_STAGE}.md" }
  retention: { $file: policies/retention.yaml }
namespaces:
  acme:
    tools:
      mode: replace
      definitions:
        - $file: tools/all.json
    budgets:
      default: { $file: budget.json }
`,
      "prompts/staging.md": "Staging rules.\n",
      "policies/retention.yaml": "version: 3\nanchor_parts: 2\n",
      "tools/all.json": JSON.stringify([
        { name: "a", input_schema: { type: "object" } },
        { name: "b", input_schema: { type: "object" } },
      ]),
      "budget.json": JSON.stringify({ version: 3, headroom: 0.3 }),
    });
    const loaded = await loadConfig(`${dir}/twigg.config.yaml`, { TWIGG_VAR_STAGE: "staging" });
    expect(loaded.desired.get(null)).toEqual({
      instructions: { mode: "append", body: "Staging rules.\n" },
      retention: { version: 3, anchor_parts: 2 },
    });
    expect(loaded.desired.get("acme")?.tools?.definitions.map((d) => d.name)).toEqual(["a", "b"]);
    expect(loaded.desired.get("acme")?.tools?.mode).toBe("replace");
    expect(loaded.desired.get("acme")?.budgets).toEqual({ default: { version: 3, headroom: 0.3 } });
  });

  it("names a missing environment variable, and keeps $${...} literal", async () => {
    const dir = await project({
      "twigg.config.yaml": "version: 1\nglobal:\n  instructions: Use ${TWIGG_VAR_MISSING}\n",
      "b.yaml": "version: 1\nglobal:\n  instructions: Write $${NAME} literally\n",
    });
    await expect(loadConfig(`${dir}/twigg.config.yaml`, {})).rejects.toThrow(
      "${TWIGG_VAR_MISSING} is not set",
    );
    const loaded = await loadConfig(`${dir}/b.yaml`, {});
    expect(loaded.desired.get(null)?.instructions?.body).toBe("Write ${NAME} literally");
  });

  it("validates the file as written and what its files hold", async () => {
    const dir = await project({
      "bad.yaml": "version: 1\nnamespaces:\n  acme:\n    prompts: hi\n",
      "worse.yaml": "version: 1\nglobal:\n  budgets:\n    default: { $file: b.json }\n",
      "b.json": JSON.stringify({ headroom: 0.1 }),
    });
    await expect(loadConfig(`${dir}/bad.yaml`, {})).rejects.toThrow(
      /does not match the configuration schema[\s\S]*prompts/,
    );
    await expect(loadConfig(`${dir}/worse.yaml`, {})).rejects.toThrow(
      /A file this configuration loads/,
    );
  });

  it("loads a TypeScript config with defineConfig, file() and tool objects", async () => {
    const dir = await project({
      "twigg.config.ts": `import { defineConfig, file } from "@twigg/cli";
import { lookup } from "./tools";

export default defineConfig({
  version: 1,
  namespaces: {
    acme: {
      instructions: { mode: "replace", body: file("prompt.md") },
      tools: { definitions: [lookup] },
    },
  },
});
`,
      // Shaped like an SDK tool(): a definition plus functions, which the loader drops.
      "tools.ts": `export const lookup = {
  name: "lookup",
  definition: { name: "lookup", description: null, input_schema: { type: "object" } },
  parse: async (value: unknown) => ({ ok: true, value }),
  run: () => "found",
};
`,
      "prompt.md": "Typed.",
    });
    const loaded = await loadConfig(`${dir}/twigg.config.ts`, {});
    expect(loaded.desired.get("acme")).toEqual({
      instructions: { mode: "replace", body: "Typed." },
      tools: {
        mode: "append",
        definitions: [{ name: "lookup", description: null, input_schema: { type: "object" } }],
      },
    });
  });
});

describe("pull and convert", () => {
  async function seeded() {
    const api = fakeApi();
    api.add("instructions", null, { mode: null, body: "Global rules.\n" });
    api.add("instructions", "acme/support", { mode: "replace", body: "Support rules." });
    api.add("tools", "acme", {
      mode: "append",
      definitions: [
        { name: "t", description: null, strict: null, input_schema: { type: "object" } },
      ],
    });
    api.add("budgets", "acme", {
      model_id: "00000000-0000-7000-8000-00000000000a",
      // The API returns whole documents, defaults included.
      budget: { ...DEFAULTS.budget, headroom: 0.2 },
    });
    api.add("retention", "acme", { rules: { ...DEFAULTS.retention, anchor_parts: 1 } });
    api.chatNamespaces.add("quiet");
    return api;
  }

  it("pulls YAML that plans no changes", async () => {
    const api = await seeded();
    const dir = await project();
    const pulled = await cli(api, dir, ["config", "pull"]);
    expect(pulled.code).toBe(0);
    const yaml = await read(dir, "twigg.config.yaml");
    expect(yaml.split("\n")[0]).toBe(
      "# yaml-language-server: $schema=https://twigg.ai/schemas/config.v1.json",
    );
    expect(yaml).toContain("claude-opus-5:");
    expect(yaml).not.toContain("quiet");
    // Only what differs from the platform defaults, so the file keeps following them.
    expect(yaml).toContain("headroom: 0.2");
    expect(yaml).toContain("anchor_parts: 1");
    expect(yaml).not.toContain("eager_compaction");
    expect(yaml).not.toContain("max_history_tokens");
    expect(yaml).not.toContain("verbatim_within");
    expect(await read(dir, "prompts/namespaces/acme/support.md")).toBe("Support rules.\n");
    const planned = await cli(api, dir, ["config", "plan"]);
    expect(planned.stdout).toContain("0 to publish, 0 to withdraw");
    expect(planned.code).toBe(0);
  });

  it("pulls TypeScript that loads and plans no changes", async () => {
    const api = await seeded();
    const dir = await project();
    await cli(api, dir, ["config", "pull", "--format", "ts"]);
    const ts = await read(dir, "twigg.config.ts");
    expect(ts).toContain('import { defineConfig, file } from "@twigg/cli";');
    expect(ts).toContain('file("prompts/global.md")');
    const planned = await cli(api, dir, ["config", "plan"]);
    expect(planned.code).toBe(0);
  });

  it("refuses to overwrite without --force", async () => {
    const api = await seeded();
    const dir = await project({ "twigg.config.yaml": "version: 1\n" });
    const result = await cli(api, dir, ["config", "pull"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force");
  });

  it("converts YAML to TypeScript and back", async () => {
    const api = fakeApi();
    const dir = await project({
      "twigg.config.yaml": "version: 1\nglobal:\n  instructions: { $file: p.md }\n",
      "p.md": "Hi",
    });
    const ts = await cli(api, dir, ["config", "convert", "--out", "twigg.config.ts"]);
    expect(ts.code).toBe(0);
    expect(await read(dir, "twigg.config.ts")).toContain(
      'instructions: file("p.md")'.replace("instructions: ", '"instructions": '),
    );
    const yaml = await cli(api, dir, [
      "config",
      "convert",
      "-c",
      "twigg.config.ts",
      "--format",
      "yaml",
    ]);
    expect(yaml.stdout).toContain("$file: p.md");
  });
});

describe("commands and exit codes", () => {
  it("validates offline", async () => {
    const api = fakeApi();
    const dir = await project({
      "twigg.config.json": JSON.stringify({ version: 1, namespaces: { acme: {} } }),
    });
    const ok = await cli(api, dir, ["config", "validate"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("1 scope (acme)");
    expect(api.calls).toEqual([]);
  });

  it("fails clearly without a config file or API key", async () => {
    const api = fakeApi();
    const dir = await project();
    expect((await cli(api, dir, ["config", "plan"])).stderr).toContain(
      "No configuration file found",
    );
    const noKey = await cli(api, dir, ["config", "resolve"], { env: { HOME: dir } });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("No API key");
  });

  it("names the platform default retention in resolve instead of printing it", async () => {
    const api = fakeApi();
    const dir = await project();
    const out = await cli(api, dir, ["config", "resolve", "--scope", "acme"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Retention: platform default");
    expect(out.stdout).not.toContain("verbatim_within");
  });

  it("prints help and version, and rejects unknown commands", async () => {
    const api = fakeApi();
    const dir = await project();
    expect((await cli(api, dir, ["--help"])).code).toBe(0);
    expect((await cli(api, dir, ["--version"])).stdout).toBe("0.1.0");
    expect((await cli(api, dir, ["config", "frobnicate"])).code).toBe(1);
    expect((await cli(api, dir, ["config", "plan", "--bogus"])).code).toBe(1);
  });

  it("emits a plan as JSON", async () => {
    const api = fakeApi();
    const dir = await project({ "twigg.config.yaml": "version: 1\nglobal:\n  instructions: Hi\n" });
    const result = await cli(api, dir, ["config", "plan", "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.publish).toBe(1);
    expect(parsed.changes[0]).toMatchObject({
      scope: null,
      surface: "instructions",
      action: "publish",
    });
  });
});

describe("credentials", () => {
  it("reads named profiles", async () => {
    expect(
      parseIni("[default]\napi_key = a\n# note\n[staging]\napi_key=b\nbase_url = https://s\n"),
    ).toEqual({
      default: { api_key: "a" },
      staging: { api_key: "b", base_url: "https://s" },
    });
    const dir = await project({ ".config/twigg/credentials": "[staging]\napi_key = tw_s\n" });
    expect(await resolveCredentials("staging", { HOME: dir })).toEqual({
      apiKey: "tw_s",
      baseURL: undefined,
    });
    await expect(resolveCredentials("prod", { HOME: dir })).rejects.toThrow('No profile "prod"');
    expect(
      await resolveCredentials(undefined, { HOME: dir, TWIGG_API_KEY: "tw_env" }),
    ).toMatchObject({ apiKey: "tw_env" });
  });

  it("treats profile names as data and keeps a profile's key and host together", async () => {
    const dir = await project({
      ".config/twigg/credentials": "[staging]\nbase_url = https://staging.test\n",
    });
    await expect(resolveCredentials("constructor", { HOME: dir })).rejects.toThrow(
      'No profile "constructor"',
    );
    await expect(resolveCredentials("__proto__", { HOME: dir })).rejects.toThrow("No profile");
    expect(
      await resolveCredentials("staging", { HOME: dir, TWIGG_API_KEY: "tw_production" }),
    ).toEqual({ apiKey: undefined, baseURL: "https://staging.test" });
  });
});

describe("32-bit floats", () => {
  it("reads stored fractions back as the decimals that were written", async () => {
    const { tidyFloats, normaliseDocument } = await import("../src/normalise.js");
    const stored = {
      headroom: 0.15000000596046448,
      eager_compaction: { at: 0.800000011920929 },
      version: 3,
    };
    expect(tidyFloats(stored)).toEqual({
      headroom: 0.15,
      eager_compaction: { at: 0.8 },
      version: 3,
    });
    expect(normaliseDocument(stored, {})).toBe(
      normaliseDocument({ headroom: 0.15, eager_compaction: { at: 0.8 }, version: 3 }, {}),
    );
  });
});
