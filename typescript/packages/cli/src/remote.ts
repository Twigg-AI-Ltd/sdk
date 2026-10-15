// The configuration as it is now: every active version in the scopes a command touches.
import type {
  CatalogueModel,
  ConfigMode,
  ContextBudget,
  DefaultPolicies,
  RetentionRules,
  ToolDefinition,
  Twigg,
} from "@twigg/sdk";
import { tidyFloats } from "./normalise.js";
import type { ScopeKey, Surface } from "./types.js";

export interface RemoteInstructions {
  id: string;
  version: number;
  mode: ConfigMode | null;
  body: string;
}

export interface RemoteTools {
  id: string;
  version: number;
  mode: ConfigMode | null;
  definitions: ToolDefinition[];
}

export interface RemoteBudget {
  id: string;
  version: number;
  /** `null` is the scope default. */
  modelId: string | null;
  budget: ContextBudget;
}

export interface RemoteRetention {
  id: string;
  version: number;
  rules: RetentionRules;
}

export interface RemoteScope {
  instructions?: RemoteInstructions;
  tools?: RemoteTools;
  budgets: RemoteBudget[];
  retention?: RemoteRetention;
}

export function hasOverrides(scope: RemoteScope): boolean {
  return !!(scope.instructions || scope.tools || scope.retention || scope.budgets.length > 0);
}

/** Query parameters selecting a scope. */
export function scopeQuery(scope: ScopeKey): { namespace?: string } {
  return scope === null ? {} : { namespace: scope };
}

export async function fetchScope(twigg: Twigg, scope: ScopeKey): Promise<RemoteScope> {
  const ns = scopeQuery(scope);
  const [instructionVersions, toolVersions, budgets, retentionVersions] = await Promise.all([
    twigg.config.instructions.versions(ns),
    twigg.config.tools.versions(ns),
    twigg.config.budgets.active(ns),
    twigg.config.retention.versions(ns),
  ]);
  const remote: RemoteScope = {
    budgets: budgets
      .filter((b) => b.is_active)
      .map((b) => ({
        id: b.id,
        version: b.version,
        modelId: b.model_id ?? null,
        budget: tidyFloats(b.budget),
      })),
  };
  const activeInstructions = instructionVersions.find((v) => v.is_active);
  if (activeInstructions) {
    const full = await twigg.config.instructions.get(activeInstructions.id);
    remote.instructions = {
      id: full.id,
      version: full.version,
      mode: full.mode ?? null,
      body: full.body,
    };
  }
  const activeTools = toolVersions.find((v) => v.is_active);
  if (activeTools) {
    const full = await twigg.config.tools.get(activeTools.id);
    remote.tools = {
      id: full.id,
      version: full.version,
      mode: full.mode ?? null,
      definitions: full.definitions,
    };
  }
  const activeRetention = retentionVersions.find((v) => v.is_active);
  if (activeRetention)
    remote.retention = {
      id: activeRetention.id,
      version: activeRetention.version,
      rules: tidyFloats(activeRetention.rules),
    };
  return remote;
}

/** Fetch several scopes, a few at a time. */
export async function fetchRemote(
  twigg: Twigg,
  scopes: ScopeKey[],
): Promise<Map<ScopeKey, RemoteScope>> {
  const remote = new Map<ScopeKey, RemoteScope>();
  let next = 0;
  const workers = Array.from({ length: Math.min(6, scopes.length) }, async () => {
    while (next < scopes.length) {
      const scope = scopes[next++] as ScopeKey;
      remote.set(scope, await fetchScope(twigg, scope));
    }
  });
  await Promise.all(workers);
  return remote;
}

/**
 * The active version ids behind one planned change, as a comparable string. Read again right
 * before applying, so a change made elsewhere since the plan stops the apply.
 */
export async function activeSignature(
  twigg: Twigg,
  scope: ScopeKey,
  surface: Surface,
  modelId?: string | null,
): Promise<string> {
  const ns = scopeQuery(scope);
  switch (surface) {
    case "instructions":
      return signature((await twigg.config.instructions.versions(ns)).filter((v) => v.is_active));
    case "tools":
      return signature((await twigg.config.tools.versions(ns)).filter((v) => v.is_active));
    case "retention":
      return signature((await twigg.config.retention.versions(ns)).filter((v) => v.is_active));
    case "budgets":
      return signature(
        (await twigg.config.budgets.active(ns)).filter(
          (b) => b.is_active && (modelId === undefined || (b.model_id ?? null) === modelId),
        ),
      );
  }
}

export function signature(versions: { id: string }[]): string {
  return versions
    .map((v) => v.id)
    .sort()
    .join(",");
}

/** Catalogue names to model ids and back. */
export class ModelNames {
  private readonly byName = new Map<string, string>();
  private readonly byId = new Map<string, string>();

  constructor(models: Pick<CatalogueModel, "id" | "name">[]) {
    for (const m of models) {
      this.byName.set(m.name, m.id);
      this.byId.set(m.id, m.name);
    }
  }

  /** The model id for a budget key; `null` for `default`. A model id is accepted as well. */
  id(key: string): string | null {
    if (key === "default") return null;
    const id = this.byName.get(key) ?? (this.byId.has(key) ? key : undefined);
    if (!id)
      throw new Error(`Unknown model "${key}" in budgets; use a name from twigg.models.list()`);
    return id;
  }

  /** The budget key for a model id: its catalogue name, or the id when the model is unlisted. */
  key(id: string | null): string {
    return id === null ? "default" : (this.byId.get(id) ?? id);
  }
}

export interface Context {
  twigg: Twigg;
  models: ModelNames;
  defaults: DefaultPolicies;
}

export async function context(twigg: Twigg): Promise<Context> {
  const [models, defaults] = await Promise.all([twigg.models.list(), twigg.config.defaults()]);
  return { twigg, models: new ModelNames(models), defaults: tidyFloats(defaults) };
}
