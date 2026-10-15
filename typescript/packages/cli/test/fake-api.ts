// An in-memory stand-in for the configuration endpoints, so plans and applies run against state
// that changes the way Twigg's does: publishing activates a new version, restoring re-activates
// an old one, withdrawing deactivates.

type Surface = "instructions" | "tools" | "budgets" | "retention";

export interface Version {
  id: string;
  surface: Surface;
  namespace: string | null;
  version: number;
  is_active: boolean;
  created_at: string;
  mode?: string | null;
  body?: string;
  definitions?: unknown[];
  model_id?: string | null;
  budget?: unknown;
  rules?: unknown;
}

export const MODELS = [
  { id: "00000000-0000-7000-8000-00000000000a", name: "claude-opus-5" },
  { id: "00000000-0000-7000-8000-00000000000b", name: "gpt-5-6-luna" },
];

export const DEFAULTS = {
  budget: {
    version: 3,
    headroom: 0.1,
    history_mode: "summarize",
    eager_compaction: { mode: "at_fill", at: 0.8 },
    max_history_tokens: null,
  },
  retention: {
    version: 3,
    media: { default: 0, rules: [] },
    tools: {
      default: { result: { mode: "keep" }, arguments: { mode: "keep" } },
      rules: [],
      errors: null,
      mark_truncations: true,
    },
    text: { prompt: { mode: "keep" }, message: { mode: "keep" } },
    reasoning: 0.3,
    verbatim_within: 0.3,
    anchor_parts: 0,
  },
};

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export function fakeApi() {
  const versions: Version[] = [];
  const calls: RecordedCall[] = [];
  /** Namespaces that have chats but no configuration. */
  const chatNamespaces = new Set<string>();
  let counter = 0;
  /** Runs before every request, for tests that change state mid-command. */
  let beforeRequest: ((call: RecordedCall) => void) | undefined;

  const view = (v: Version) => {
    const { surface: _surface, body: _body, definitions: _definitions, ...rest } = v;
    return { ...rest, estimated_tokens: 0 };
  };

  function add(
    surface: Surface,
    namespace: string | null,
    fields: Partial<Version>,
    activate = true,
  ): Version {
    const model = surface === "budgets" ? (fields.model_id ?? null) : undefined;
    const same = (v: Version) =>
      v.surface === surface &&
      v.namespace === namespace &&
      (surface !== "budgets" || (v.model_id ?? null) === model);
    const version: Version = {
      id: `${surface}-${++counter}`,
      surface,
      namespace,
      version: versions.filter(same).length + 1,
      is_active: false,
      created_at: `2026-10-14T10:00:${String(counter).padStart(2, "0")}Z`,
      ...fields,
    };
    if (activate) {
      for (const v of versions) if (same(v)) v.is_active = false;
      version.is_active = true;
    }
    versions.push(version);
    return version;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const query = Object.fromEntries(url.searchParams.entries());
    const call = { method, path: url.pathname, query, body };
    beforeRequest?.(call);
    calls.push(call);
    const ns = query.namespace ?? null;
    const path = url.pathname;

    if (path === "/api/v1/models") return json(MODELS);
    if (path === "/api/v1/config/defaults") return json(DEFAULTS);
    if (path === "/api/v1/config/namespaces")
      return json(
        [
          ...new Set([
            ...chatNamespaces,
            ...versions.flatMap((v) => (v.namespace === null ? [] : [v.namespace])),
          ]),
        ].sort(),
      );
    if (path === "/api/v1/config/resolved")
      return json({
        namespace: ns,
        instructions: null,
        tools: [],
        retention: DEFAULTS.retention,
        estimated_tokens: 0,
        versions: {},
      });

    const match =
      /^\/api\/v1\/config\/(instructions|tools|budgets|retention)(?:\/(versions|active|[^/]+))?(?:\/(activate))?$/.exec(
        path,
      );
    if (!match) return json({ error: { code: "not_found", message: `no route ${path}` } }, 404);
    const surface = match[1] as Surface;
    const segment = match[2];
    const inScope = (v: Version) => v.surface === surface && v.namespace === ns;

    if (method === "POST" && !segment) {
      const target = body.namespace ?? null;
      if (surface === "instructions")
        return json(view(add(surface, target, { mode: body.mode, body: body.body })));
      if (surface === "tools")
        return json(view(add(surface, target, { mode: body.mode, definitions: body.definitions })));
      if (surface === "retention")
        return json({ ...view(add(surface, target, { rules: body.rules })), rules: body.rules });
      const models: (string | null)[] = body.model_ids?.length ? body.model_ids : [null];
      return json(
        models.map((model_id) => {
          const v = add(surface, target, { model_id, budget: body.budget });
          return { ...view(v), budget: v.budget, model_id };
        }),
      );
    }
    if (method === "POST" && match[3] === "activate") {
      const v = versions.find((x) => x.id === segment);
      if (!v) return json({ error: { code: "not_found", message: "no version" } }, 404);
      for (const other of versions)
        if (
          other.surface === v.surface &&
          other.namespace === v.namespace &&
          (other.model_id ?? null) === (v.model_id ?? null)
        )
          other.is_active = false;
      v.is_active = true;
      return json(surface === "budgets" ? { ...view(v), budget: v.budget } : view(v));
    }
    if (method === "DELETE" && segment === "active") {
      const model = query.model ?? null;
      let was = false;
      for (const v of versions)
        if (
          inScope(v) &&
          v.is_active &&
          (surface !== "budgets" || (v.model_id ?? null) === model)
        ) {
          v.is_active = false;
          was = true;
        }
      return json({ was_active: was });
    }
    if (method === "GET" && surface === "budgets" && !segment)
      return json(
        versions
          .filter((v) => inScope(v) && v.is_active)
          .map((v) => ({ ...view(v), budget: v.budget })),
      );
    if (method === "GET" && surface === "budgets" && segment === "versions")
      return json(
        versions
          .filter((v) => inScope(v) && (query.model === undefined || v.model_id === query.model))
          .map((v) => ({ ...view(v), budget: v.budget })),
      );
    if (method === "GET" && !segment)
      return json(
        versions
          .filter(inScope)
          .map((v) => (surface === "retention" ? { ...view(v), rules: v.rules } : view(v))),
      );
    if (method === "GET" && segment) {
      const v = versions.find((x) => x.id === segment);
      if (!v) return json({ error: { code: "not_found", message: "no version" } }, 404);
      return json(
        surface === "instructions"
          ? { ...view(v), body: v.body }
          : { ...view(v), definitions: v.definitions },
      );
    }
    return json({ error: { code: "not_found", message: `no route ${method} ${path}` } }, 404);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    versions,
    calls,
    chatNamespaces,
    add,
    /** Mutating calls, as "METHOD path?namespace" strings, in order. */
    writes: () =>
      calls
        .filter((c) => c.method !== "GET")
        .map((c) => {
          const ns = (c.body as { namespace?: string } | undefined)?.namespace ?? c.query.namespace;
          return `${c.method} ${c.path}${ns ? ` ${ns}` : ""}`;
        }),
    active: (surface: Surface, namespace: string | null) =>
      versions.filter((v) => v.surface === surface && v.namespace === namespace && v.is_active),
    onRequest: (hook: (call: RecordedCall) => void) => {
      beforeRequest = hook;
    },
  };
}
