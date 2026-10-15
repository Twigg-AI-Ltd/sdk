// Desired against remote: what would change, and applying it in a safe order.
import type { ConfigMode, ContextBudget, RetentionRules, ToolDefinition } from "@twigg/sdk";
import type { Desired, DesiredScope } from "./load.js";
import {
  estimateTokens,
  lineStats,
  normaliseBody,
  normaliseDocument,
  normaliseTools,
} from "./normalise.js";
import {
  activeSignature,
  type Context,
  fetchRemote,
  hasOverrides,
  type RemoteScope,
  scopeQuery,
} from "./remote.js";
import { type ScopeKey, SURFACES, type Surface, scopeLabel } from "./types.js";

export type Action = "publish" | "withdraw" | "unchanged" | "unmanaged";

export type Operation =
  | { kind: "instructions"; mode: ConfigMode; body: string }
  | { kind: "tools"; mode: ConfigMode; definitions: ToolDefinition[] }
  | { kind: "budget"; modelId: string | null; budget: ContextBudget }
  | { kind: "retention"; rules: RetentionRules }
  | { kind: "withdraw"; modelId?: string | null };

export interface Change {
  scope: ScopeKey;
  surface: Surface;
  /** For budgets: `default` or the catalogue model name. */
  key?: string;
  action: Action;
  /** One line for people: what changes, or what an unmanaged override does. */
  detail: string;
  /** The active version ids at plan time, checked again before applying. */
  current: string;
  /** What applying does. Absent for unchanged and unmanaged entries. */
  operation?: Operation;
  /** A withdrawal from pruning: the scope is not in the file at all. */
  pruned?: true;
  /** For a publish: an earlier version with the same content, which a rollback could restore. */
  matches?: number;
}

export interface Plan {
  changes: Change[];
  counts: {
    publish: number;
    withdraw: number;
    unchanged: number;
    unmanaged: number;
    /** How many of the withdrawals come from pruning. */
    pruned: number;
  };
}

export interface PlanOptions {
  /** Only this namespace and everything beneath it. */
  scope?: string;
  /** Withdraw overrides in scopes the file does not mention. */
  prune?: boolean;
}

/** Whether `namespace` is `scope` or beneath it. */
export function within(namespace: string, scope: string): boolean {
  return namespace === scope || namespace.startsWith(`${scope}/`);
}

/** Global first, then parents before children, then alphabetically. */
export function scopeOrder(a: ScopeKey, b: ScopeKey): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const depth = a.split("/").length - b.split("/").length;
  return depth !== 0 ? depth : a.localeCompare(b);
}

/** The scopes a command covers: those in the file, plus every scope Twigg knows, filtered. */
export async function scopesInPlay(
  ctx: Context,
  declared: Iterable<ScopeKey>,
  scope: string | undefined,
): Promise<ScopeKey[]> {
  const all = new Set<ScopeKey>([...declared, ...(await ctx.twigg.config.namespaces())]);
  if (scope === undefined) all.add(null);
  return [...all]
    .filter((s) => scope === undefined || (s !== null && within(s, scope)))
    .sort(scopeOrder);
}

export async function plan(
  ctx: Context,
  desired: Desired,
  options: PlanOptions = {},
): Promise<Plan> {
  const scopes = await scopesInPlay(ctx, desired.keys(), options.scope);
  const remote = await fetchRemote(ctx.twigg, scopes);
  const changes: Change[] = [];
  for (const scope of scopes) {
    const now = remote.get(scope) ?? { budgets: [] };
    const wanted = desired.get(scope);
    if (wanted) changes.push(...diffScope(ctx, scope, wanted, now));
    else if (hasOverrides(now))
      changes.push(
        ...(options.prune ? pruneScope(ctx, scope, now) : describeUnmanaged(ctx, scope, now)),
      );
  }
  await Promise.all(
    changes
      .filter((c) => c.action === "publish" && c.current !== "")
      .map(async (change) => {
        const version = await earlierMatch(ctx, change);
        if (version !== undefined) change.matches = version;
      }),
  );
  const counts = { publish: 0, withdraw: 0, unchanged: 0, unmanaged: 0, pruned: 0 };
  for (const change of changes) {
    counts[change.action]++;
    if (change.pruned) counts.pruned++;
  }
  return { changes, counts };
}

/** How many earlier versions a plan reads to spot that a change matches one of them. */
const RECENT_VERSIONS = 5;

/**
 * The newest earlier version whose content is what this change would publish, so the plan can
 * suggest restoring it instead. Only a hint: applying still publishes a new version.
 */
async function earlierMatch(ctx: Context, change: Change): Promise<number | undefined> {
  const op = change.operation;
  const ns = scopeQuery(change.scope);
  const config = ctx.twigg.config;
  const recent = <V extends { is_active: boolean; version: number }>(versions: V[]) =>
    versions
      .filter((v) => !v.is_active)
      .sort((a, b) => b.version - a.version)
      .slice(0, RECENT_VERSIONS);
  switch (op?.kind) {
    case "instructions":
      for (const v of recent(await config.instructions.versions(ns))) {
        if (change.scope !== null && (v.mode ?? "append") !== op.mode) continue;
        const { body } = await config.instructions.get(v.id);
        if (normaliseBody(body) === normaliseBody(op.body)) return v.version;
      }
      return undefined;
    case "tools":
      for (const v of recent(await config.tools.versions(ns))) {
        if (change.scope !== null && (v.mode ?? "append") !== op.mode) continue;
        const { definitions } = await config.tools.get(v.id);
        if (normaliseTools(definitions) === normaliseTools(op.definitions)) return v.version;
      }
      return undefined;
    case "budget": {
      const query = op.modelId ? { ...ns, model: op.modelId } : ns;
      const wanted = normaliseDocument(op.budget, ctx.defaults.budget);
      return recent(
        (await config.budgets.versions(query)).filter((v) => (v.model_id ?? null) === op.modelId),
      ).find((v) => normaliseDocument(v.budget, ctx.defaults.budget) === wanted)?.version;
    }
    case "retention": {
      const wanted = normaliseDocument(op.rules, ctx.defaults.retention);
      return recent(await config.retention.versions(ns)).find(
        (v) => normaliseDocument(v.rules, ctx.defaults.retention) === wanted,
      )?.version;
    }
    default:
      return undefined;
  }
}

function diffScope(
  ctx: Context,
  scope: ScopeKey,
  wanted: DesiredScope,
  now: RemoteScope,
): Change[] {
  const changes: Change[] = [];
  const base = { scope };

  if (wanted.instructions !== undefined) {
    const current = now.instructions;
    const sig = current ? current.id : "";
    if (wanted.instructions === null)
      changes.push(
        current
          ? {
              ...base,
              surface: "instructions",
              action: "withdraw",
              detail: `withdraw v${current.version}${inherits(scope)}`,
              current: sig,
              operation: { kind: "withdraw" },
            }
          : { ...base, surface: "instructions", action: "unchanged", detail: "none", current: sig },
      );
    else {
      const { mode, body } = wanted.instructions;
      // The API ignores mode on the organisation-wide scope, so it never counts there.
      const same =
        current &&
        normaliseBody(current.body) === normaliseBody(body) &&
        (scope === null || (current.mode ?? "append") === mode);
      const tokens = `~${estimateTokens(body)} tokens`;
      if (same)
        changes.push({
          ...base,
          surface: "instructions",
          action: "unchanged",
          detail: `v${current.version} unchanged`,
          current: sig,
        });
      else {
        let detail = `${tokens}${scope === null ? "" : `, ${mode}`}`;
        if (current) {
          const { added, removed } = lineStats(normaliseBody(current.body), normaliseBody(body));
          const modeChange =
            scope !== null && (current.mode ?? "append") !== mode
              ? `, ${current.mode ?? "append"} -> ${mode}`
              : "";
          detail = `v${current.version} -> new (+${added} lines, -${removed} lines${modeChange})  ${tokens}`;
        }
        changes.push({
          ...base,
          surface: "instructions",
          action: "publish",
          detail,
          current: sig,
          operation: { kind: "instructions", mode, body },
        });
      }
    }
  }

  if (wanted.tools !== undefined) {
    const current = now.tools;
    const sig = current ? current.id : "";
    if (wanted.tools === null)
      changes.push(
        current
          ? {
              ...base,
              surface: "tools",
              action: "withdraw",
              detail: `withdraw v${current.version}${inherits(scope)}`,
              current: sig,
              operation: { kind: "withdraw" },
            }
          : { ...base, surface: "tools", action: "unchanged", detail: "none", current: sig },
      );
    else {
      const { mode, definitions } = wanted.tools;
      const same =
        current &&
        normaliseTools(current.definitions) === normaliseTools(definitions) &&
        (current.mode ?? "append") === mode;
      const names = definitions.map((d) => d.name).join(", ") || "(empty bundle)";
      const tokens = `~${estimateTokens(JSON.stringify(definitions))} tokens`;
      changes.push(
        same
          ? {
              ...base,
              surface: "tools",
              action: "unchanged",
              detail: `v${current.version} unchanged`,
              current: sig,
            }
          : {
              ...base,
              surface: "tools",
              action: "publish",
              detail: `${current ? `v${current.version} -> new: ` : ""}${names} (${mode})  ${tokens}`,
              current: sig,
              operation: { kind: "tools", mode, definitions },
            },
      );
    }
  }

  if (wanted.budgets !== undefined) {
    const wantedBudgets = wanted.budgets ?? {};
    const wantedIds = new Map<string | null, [string, ContextBudget]>();
    for (const [key, budget] of Object.entries(wantedBudgets))
      wantedIds.set(ctx.models.id(key), [key, budget]);
    for (const [modelId, [key, budget]] of wantedIds) {
      const current = now.budgets.find((b) => b.modelId === modelId);
      const sig = current ? current.id : "";
      const same =
        current &&
        normaliseDocument(current.budget, ctx.defaults.budget) ===
          normaliseDocument(budget, ctx.defaults.budget);
      changes.push(
        same
          ? {
              ...base,
              surface: "budgets",
              key,
              action: "unchanged",
              detail: `${key}: v${current.version} unchanged`,
              current: sig,
            }
          : {
              ...base,
              surface: "budgets",
              key,
              action: "publish",
              detail: `${key}: ${current ? `v${current.version} -> new` : "new"}`,
              current: sig,
              operation: { kind: "budget", modelId, budget },
            },
      );
    }
    for (const current of now.budgets)
      if (!wantedIds.has(current.modelId)) {
        const key = ctx.models.key(current.modelId);
        changes.push({
          ...base,
          surface: "budgets",
          key,
          action: "withdraw",
          detail: `${key}: withdraw v${current.version}`,
          current: current.id,
          operation: { kind: "withdraw", modelId: current.modelId },
        });
      }
    if (wantedIds.size === 0 && now.budgets.length === 0)
      changes.push({
        ...base,
        surface: "budgets",
        action: "unchanged",
        detail: "none",
        current: "",
      });
  }

  if (wanted.retention !== undefined) {
    const current = now.retention;
    const sig = current ? current.id : "";
    if (wanted.retention === null)
      changes.push(
        current
          ? {
              ...base,
              surface: "retention",
              action: "withdraw",
              detail: `withdraw v${current.version}${inherits(scope)}`,
              current: sig,
              operation: { kind: "withdraw" },
            }
          : { ...base, surface: "retention", action: "unchanged", detail: "none", current: sig },
      );
    else {
      const rules = wanted.retention;
      const same =
        current &&
        normaliseDocument(current.rules, ctx.defaults.retention) ===
          normaliseDocument(rules, ctx.defaults.retention);
      changes.push(
        same
          ? {
              ...base,
              surface: "retention",
              action: "unchanged",
              detail: `v${current.version} unchanged`,
              current: sig,
            }
          : {
              ...base,
              surface: "retention",
              action: "publish",
              detail: current ? `v${current.version} -> new` : "new policy",
              current: sig,
              operation: { kind: "retention", rules },
            },
      );
    }
  }
  return changes;
}

/** Withdraw every override in a scope the file does not mention. */
function pruneScope(ctx: Context, scope: ScopeKey, now: RemoteScope): Change[] {
  const changes: Change[] = [];
  for (const surface of ["instructions", "tools", "retention"] as const) {
    const current = now[surface];
    if (current)
      changes.push({
        scope,
        surface,
        action: "withdraw",
        detail: `withdraw v${current.version} (not in the file)`,
        current: current.id,
        pruned: true,
        operation: { kind: "withdraw" },
      });
  }
  for (const budget of now.budgets) {
    const key = ctx.models.key(budget.modelId);
    changes.push({
      scope,
      surface: "budgets",
      key,
      action: "withdraw",
      detail: `${key}: withdraw v${budget.version} (not in the file)`,
      current: budget.id,
      pruned: true,
      operation: { kind: "withdraw", modelId: budget.modelId },
    });
  }
  return sortBySurface(changes);
}

/** Overrides the file does not manage, shown so a reviewer sees what shadows the change. */
function describeUnmanaged(ctx: Context, scope: ScopeKey, now: RemoteScope): Change[] {
  const changes: Change[] = [];
  const parent =
    scope === null
      ? undefined
      : scope.includes("/")
        ? scope.slice(0, scope.lastIndexOf("/"))
        : scopeLabel(null);
  const shadows = (mode: ConfigMode | null) =>
    mode === "replace" && parent ? `, shadows ${parent}` : "";
  if (now.instructions)
    changes.push({
      scope,
      surface: "instructions",
      action: "unmanaged",
      detail: `${now.instructions.mode ?? "append"} v${now.instructions.version}${shadows(now.instructions.mode)}`,
      current: now.instructions.id,
    });
  if (now.tools)
    changes.push({
      scope,
      surface: "tools",
      action: "unmanaged",
      detail: `${now.tools.mode ?? "append"} v${now.tools.version}${shadows(now.tools.mode)}`,
      current: now.tools.id,
    });
  for (const budget of now.budgets)
    changes.push({
      scope,
      surface: "budgets",
      key: ctx.models.key(budget.modelId),
      action: "unmanaged",
      detail: `${ctx.models.key(budget.modelId)} v${budget.version}`,
      current: budget.id,
    });
  if (now.retention)
    changes.push({
      scope,
      surface: "retention",
      action: "unmanaged",
      detail: `v${now.retention.version}`,
      current: now.retention.id,
    });
  return changes;
}

function sortBySurface(changes: Change[]): Change[] {
  return changes.sort((a, b) => SURFACES.indexOf(a.surface) - SURFACES.indexOf(b.surface));
}

function inherits(scope: ScopeKey): string {
  if (scope === null) return " (platform defaults apply)";
  const parent = scope.includes("/") ? scope.slice(0, scope.lastIndexOf("/")) : scopeLabel(null);
  return ` (inherits from ${parent})`;
}

export interface Applied {
  /** The namespace, or null for the organisation-wide scope. */
  scope: ScopeKey;
  surface: Surface;
  key?: string;
  action: "publish" | "withdraw";
  /** The new version's id, for a publish. */
  versionIds?: string[];
}

/** A change made elsewhere since the plan was read. Nothing after it was applied. */
export class DriftError extends Error {
  override name = "DriftError";
  constructor(
    message: string,
    readonly applied: Applied[],
  ) {
    super(message);
  }
}

/**
 * Apply a plan's publishes and withdrawals in order: global first, parents before children.
 * Each change first re-reads its active versions and stops everything if they moved.
 */
export async function apply(
  ctx: Context,
  planned: Plan,
  onApplied: (applied: Applied) => void = () => {},
): Promise<Applied[]> {
  const applied: Applied[] = [];
  const { twigg } = ctx;
  for (const change of planned.changes) {
    const op = change.operation;
    if (!op || (change.action !== "publish" && change.action !== "withdraw")) continue;
    const modelId =
      op.kind === "budget" ? op.modelId : op.kind === "withdraw" ? op.modelId : undefined;
    const now = await activeSignature(
      twigg,
      change.scope,
      change.surface,
      change.surface === "budgets" ? (modelId ?? null) : undefined,
    );
    if (now !== change.current)
      throw new DriftError(
        `${scopeLabel(change.scope)} ${change.surface}${change.key ? ` (${change.key})` : ""} changed since the plan was made; run plan again`,
        applied,
      );
    const ns = scopeQuery(change.scope);
    let versionIds: string[] | undefined;
    switch (op.kind) {
      case "instructions":
        versionIds = [
          (await twigg.config.instructions.publish({ ...ns, mode: op.mode, body: op.body })).id,
        ];
        break;
      case "tools":
        versionIds = [
          (await twigg.config.tools.publish({ ...ns, mode: op.mode, definitions: op.definitions }))
            .id,
        ];
        break;
      case "budget":
        versionIds = (
          await twigg.config.budgets.publish({
            ...ns,
            model_ids: op.modelId ? [op.modelId] : [],
            budget: op.budget,
          })
        ).map((v) => v.id);
        break;
      case "retention":
        versionIds = [(await twigg.config.retention.publish({ ...ns, rules: op.rules })).id];
        break;
      case "withdraw":
        if (change.surface === "instructions") await twigg.config.instructions.withdraw(ns);
        else if (change.surface === "tools") await twigg.config.tools.withdraw(ns);
        else if (change.surface === "retention") await twigg.config.retention.withdraw(ns);
        else await twigg.config.budgets.withdraw(op.modelId ? { ...ns, model: op.modelId } : ns);
        break;
    }
    const done: Applied = {
      scope: change.scope,
      surface: change.surface,
      ...(change.key ? { key: change.key } : {}),
      action: change.action,
      ...(versionIds ? { versionIds } : {}),
    };
    applied.push(done);
    onApplied(done);
  }
  return applied;
}
