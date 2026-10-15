// The configuration file's shape, mirroring spec/config.v1.json. The surface documents are the
// SDK's generated API types, which the schema's $defs are copied from, so the two cannot drift.
import type {
  AnyTool,
  ConfigMode,
  ContextBudget,
  RetentionRules,
  ToolDefinition,
} from "@twigg/sdk";

/** Load this value from a file, relative to the configuration file. */
export interface FileReference {
  $file: string;
}

export type Text = string | FileReference;

export interface ScopeInstructions {
  /** How this scope combines with its parent. Defaults to `append`; ignored on `global`. */
  mode?: ConfigMode;
  body: Text;
}

export interface ScopeTools {
  /** How this scope combines with its parent. Defaults to `append`. */
  mode?: ConfigMode;
  /** The whole bundle. In a TypeScript file, SDK `tool()` objects work too. */
  definitions: (ToolDefinition | FileReference | AnyTool)[];
}

/**
 * Keyed by `default` (every model without its own) or a catalogue model name. The map is the
 * scope's whole set: an active budget for a key not listed here is withdrawn.
 */
export type ScopeBudgets = Record<string, ContextBudget | FileReference | null>;

/** One scope. A surface left out is unmanaged; `null` withdraws its override. */
export interface Scope {
  instructions?: Text | ScopeInstructions | null;
  tools?: ScopeTools | null;
  budgets?: ScopeBudgets | null;
  retention?: RetentionRules | FileReference | null;
}

export interface ConfigFile {
  $schema?: string;
  version: 1;
  /** The organisation-wide scope every namespace inherits from. */
  global?: Scope;
  /** Namespace scopes, keyed by namespace. */
  namespaces?: Record<string, Scope>;
}

export type Surface = "instructions" | "tools" | "budgets" | "retention";
export const SURFACES: Surface[] = ["instructions", "tools", "budgets", "retention"];

/** A scope key: `null` is the organisation-wide scope, otherwise a namespace. */
export type ScopeKey = string | null;

/**
 * How a scope reads in output. The organisation-wide scope is not called "global", since that is
 * also a valid namespace name and the two would look the same in a plan.
 */
export function scopeLabel(scope: ScopeKey): string {
  return scope ?? "(organisation)";
}
