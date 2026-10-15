// Plans and results as text for people.
import type { Applied, Change, Plan } from "./plan.js";
import { scopeLabel } from "./types.js";

const SYMBOL = { publish: "+", withdraw: "-", unchanged: "=", unmanaged: "!" } as const;

export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  let scope: string | undefined;
  for (const change of plan.changes) {
    const label = scopeLabel(change.scope);
    if (label !== scope) {
      const inScope = plan.changes.filter((c) => scopeLabel(c.scope) === label);
      const note = inScope.every((c) => c.action === "unmanaged")
        ? "   (unmanaged)"
        : inScope.every((c) => c.pruned)
          ? "   (not in the file: pruning withdraws all of it)"
          : "";
      lines.push(label + note);
      scope = label;
    }
    lines.push(`  ${symbol(change)} ${change.surface.padEnd(13)} ${change.detail}`);
  }
  const { publish, withdraw, unchanged, unmanaged, pruned } = plan.counts;
  if (lines.length === 0) lines.push("Nothing to manage in this scope.");
  lines.push(
    "",
    `Plan: ${publish} to publish, ${withdraw} to withdraw${pruned ? ` (${pruned} pruned)` : ""}, ${unchanged} unchanged${
      unmanaged ? `, ${unmanaged} unmanaged (not in the file; --prune withdraws them)` : ""
    }.`,
  );
  return lines.join("\n");
}

function symbol(change: Change): string {
  if (change.action === "publish" && change.current !== "") return "~";
  return SYMBOL[change.action];
}

export function renderApplied(applied: Applied): string {
  const what = `${scopeLabel(applied.scope)} ${applied.surface}${applied.key ? ` (${applied.key})` : ""}`;
  return applied.action === "publish"
    ? `published ${what}: ${applied.versionIds?.join(", ") ?? ""}`
    : `withdrew ${what}`;
}
