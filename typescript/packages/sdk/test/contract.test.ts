// Every operation in the pinned spec is either covered by an SDK call, sent with the method,
// path and query parameters the spec declares, or listed as deliberately not yet covered.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Twigg } from "../src/index.js";
import { json, setup, sseResponse, textTurn } from "./helpers.js";

interface Operation {
  operationId: string;
  parameters?: { in: string; name: string }[];
}
const spec = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../../spec/openapi.json"), "utf8"),
) as { paths: Record<string, Record<string, Operation>> };
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ ...op, path, method: method.toUpperCase() })),
);

/** Operations deliberately not exposed by the SDK. */
const NOT_YET = new Set<string>();

const page = { data: [], first_id: null, last_id: null, has_more: false };
const historyPage = { data: [], first_ordinal: null, last_ordinal: null, has_more: false };
const id = "0192f0a0-0000-7000-8000-000000000001";

const calls: Record<string, { call: (t: Twigg) => Promise<unknown>; reply?: unknown }> = {
  discovery: { call: (t) => t.meta.discovery() },
  get: { call: (t) => t.meta.version() },
  listPublicUpdates: { call: (t) => t.meta.updates(), reply: [] },
  listChats: {
    call: (t) => t.chats.list({ namespace: "acme", after_id: id, limit: 10 }).then(),
    reply: page,
  },
  createChat: { call: (t) => t.chats.create({ namespace: "acme", title: "Billing" }) },
  getChat: { call: (t) => t.chats.get(id) },
  deleteChat: { call: (t) => t.chats.delete(id) },
  openChatByExternalId: {
    call: (t) => t.chats.openByExternalId("+44 7700", { namespace: "acme" }),
    reply: { id },
  },
  getChatByExternalId: { call: (t) => t.chats.getByExternalId("+447700") },
  deleteChatByExternalId: { call: (t) => t.chats.deleteByExternalId("+447700") },
  getChatHistoryByExternalId: {
    call: (t) => t.chats.historyByExternalId("+447700", { after_ordinal: -1, limit: 5 }).then(),
    reply: historyPage,
  },
  importChatByExternalId: {
    call: (t) =>
      t.chats.importByExternalId("+447700", {
        parts: [{ type: "prompt", text: "Hi" }],
        chat: { namespace: "acme" },
      }),
  },
  createResponseByExternalId: {
    call: (t) =>
      t.responses
        .createByExternalId("+447700", {
          model: "claude-opus-5",
          input: [{ type: "prompt", text: "Hi" }],
          chat: { namespace: "acme" },
        })
        .final(),
  },
  abortResponseByExternalId: {
    call: (t) => t.responses.abortByExternalId("+447700", { run_id: id }),
  },
  getChatHistory: {
    call: (t) => t.chats.history(id, { before_ordinal: 9, limit: 5, include: "none" }).then(),
    reply: historyPage,
  },
  createResponse: {
    call: (t) =>
      t.responses
        .create(id, { model: "claude-opus-5", input: [{ type: "prompt", text: "Hi" }] })
        .final(),
  },
  abortResponse: { call: (t) => t.responses.abort(id, { run_id: id }) },
  getRun: { call: (t) => t.runs.get(id) },
  listModels: { call: (t) => t.models.list(), reply: [] },
  listNamespaces: { call: (t) => t.namespaces.list().then(), reply: { data: [] } },
  queryUsage: {
    call: (t) => t.usage.query({ range: "7d", bin: "day", group_by: "model", namespace: "acme" }),
  },
  listCatalogue: { call: (t) => t.catalogue.list() },
  getCatalogueModel: { call: (t) => t.catalogue.get("claude-opus-5") },
  getCatalogueMarkdown: { call: (t) => t.catalogue.markdown() },
  getConfigurationDefaults: { call: (t) => t.config.defaults() },
  listConfigurationNamespaces: { call: (t) => t.config.namespaces(), reply: [] },
  resolveConfiguration: { call: (t) => t.config.resolve({ namespace: "acme" }) },
  resolveContextBudget: {
    call: (t) => t.config.resolveBudget({ namespace: "acme", model: id }),
  },
  publishInstructions: {
    call: (t) => t.config.instructions.publish({ mode: "append", body: "Be brief." }),
  },
  listInstructionVersions: {
    call: (t) => t.config.instructions.versions({ namespace: "acme" }),
    reply: [],
  },
  getInstructions: { call: (t) => t.config.instructions.get(id) },
  restoreInstructions: { call: (t) => t.config.instructions.restore(id) },
  withdrawInstructions: { call: (t) => t.config.instructions.withdraw({ namespace: "acme" }) },
  publishTools: { call: (t) => t.config.tools.publish({ mode: "append", definitions: [] }) },
  listToolVersions: { call: (t) => t.config.tools.versions({ namespace: "acme" }), reply: [] },
  getTools: { call: (t) => t.config.tools.get(id) },
  restoreTools: { call: (t) => t.config.tools.restore(id) },
  withdrawTools: { call: (t) => t.config.tools.withdraw({ namespace: "acme" }) },
  publishBudgets: {
    call: (t) => t.config.budgets.publish({ budget: { version: 3, headroom: 0.1 } }),
    reply: [],
  },
  listActiveBudgets: { call: (t) => t.config.budgets.active({ namespace: "acme" }), reply: [] },
  listBudgetVersions: {
    call: (t) => t.config.budgets.versions({ namespace: "acme", model: id }),
    reply: [],
  },
  restoreBudget: { call: (t) => t.config.budgets.restore(id) },
  withdrawBudget: { call: (t) => t.config.budgets.withdraw({ namespace: "acme", model: id }) },
  publishRetention: { call: (t) => t.config.retention.publish({ rules: { version: 3 } }) },
  listRetentionVersions: {
    call: (t) => t.config.retention.versions({ namespace: "acme" }),
    reply: [],
  },
  restoreRetention: { call: (t) => t.config.retention.restore(id) },
  withdrawRetention: { call: (t) => t.config.retention.withdraw({ namespace: "acme" }) },
};

describe("API contract", () => {
  it("covers every operation in the spec", () => {
    const uncovered = operations
      .map((op) => op.operationId)
      .filter((op) => !(op in calls) && !NOT_YET.has(op));
    expect(uncovered).toEqual([]);
    const unknown = Object.keys(calls).filter(
      (op) => !operations.some((o) => o.operationId === op),
    );
    expect(unknown).toEqual([]);
  });

  it.each(operations.filter((op) => op.operationId in calls))(
    "$operationId sends $method $path",
    async (op) => {
      const { twigg, api } = setup();
      const entry = calls[op.operationId];
      if (!entry) throw new Error("unreachable");
      api.reply(
        op.operationId === "createResponse" || op.operationId === "createResponseByExternalId"
          ? sseResponse(textTurn())
          : op.operationId === "getCatalogueMarkdown"
            ? new Response("|")
            : op.operationId === "deleteChat" || op.operationId === "deleteChatByExternalId"
              ? new Response(null, { status: 204 })
              : json(entry.reply ?? {}),
      );
      await entry.call(twigg);

      const sent = api.last;
      expect(sent.method).toBe(op.method);
      const template = new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
      expect(sent.url.pathname).toMatch(template);
      const declared = new Set(
        (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name),
      );
      for (const name of sent.url.searchParams.keys()) expect(declared).toContain(name);
    },
  );
});
