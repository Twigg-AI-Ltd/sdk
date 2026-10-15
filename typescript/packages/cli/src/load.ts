// Reading a configuration file into the desired state: parse it, validate it against the
// published schema as written, substitute ${TWIGG_VAR_*}s, load $file references, validate again.
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigMode, ContextBudget, RetentionRules, ToolDefinition } from "@twigg/sdk";
import { createJiti } from "jiti";
import YAML from "yaml";
import { validate } from "./schema.js";
import type { ConfigFile, FileReference, Scope, ScopeKey, Text } from "./types.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface DesiredInstructions {
  mode: ConfigMode;
  body: string;
}

export interface DesiredTools {
  mode: ConfigMode;
  definitions: ToolDefinition[];
}

/** One scope's managed surfaces. Absent is unmanaged; `null` withdraws. */
export interface DesiredScope {
  instructions?: DesiredInstructions | null;
  tools?: DesiredTools | null;
  /** By `default` or catalogue model name. The whole set: unlisted active budgets go. */
  budgets?: Record<string, ContextBudget> | null;
  retention?: RetentionRules | null;
}

export type Desired = Map<ScopeKey, DesiredScope>;

export interface LoadedConfig {
  path: string;
  /** The file as written, with SDK tool objects turned into plain definitions. */
  raw: ConfigFile;
  desired: Desired;
}

/** The configuration files looked for, in order, when none is named. */
export const DEFAULT_FILES = [
  "twigg.config.ts",
  "twigg.config.mts",
  "twigg.config.yaml",
  "twigg.config.yml",
  "twigg.config.json",
];

export async function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedConfig> {
  const raw = await readRaw(path);
  check(raw, path);
  const dir = dirname(path);
  const interpolated = interpolate(raw, env) as ConfigFile;
  const desired: Desired = new Map();
  if (interpolated.global) desired.set(null, await resolveScope(interpolated.global, dir));
  for (const [namespace, scope] of Object.entries(interpolated.namespaces ?? {}))
    desired.set(namespace, await resolveScope(scope, dir));
  return { path, raw, desired };
}

/** Parse a configuration file without resolving anything in it. */
export async function readRaw(path: string): Promise<ConfigFile> {
  const extension = extname(path).toLowerCase();
  if ([".ts", ".mts", ".js", ".mjs"].includes(extension)) return plain(await importConfig(path));
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new ConfigError(
      error.code === "ENOENT" ? `${path} does not exist` : `Cannot read ${path}: ${error.message}`,
    );
  });
  try {
    return (extension === ".json" ? JSON.parse(text) : YAML.parse(text)) as ConfigFile;
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid ${extension === ".json" ? "JSON" : "YAML"}: ${message(error)}`,
    );
  }
}

/**
 * Load a TypeScript config with jiti. Node's own type stripping is unflagged only from 22.18,
 * does not resolve extensionless imports such as `./tools`, and refuses TypeScript inside
 * node_modules; jiti handles all three on every supported Node, with no build step.
 */
async function importConfig(path: string): Promise<unknown> {
  // `@twigg/cli` in the config resolves to this running CLI, so `npx @twigg/cli` works in a
  // project that never installed it.
  const self = fileURLToPath(
    new URL(`./index${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    alias: { "@twigg/cli": self },
  });
  try {
    return await jiti.import(resolve(path), { default: true });
  } catch (error) {
    throw new ConfigError(`Cannot load ${path}: ${message(error)}`);
  }
}

/** Replace SDK tool objects by their definitions, and drop anything that is not JSON. */
function plain(value: unknown): ConfigFile {
  const replace = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(replace);
    if (item && typeof item === "object") {
      const tool = item as { definition?: unknown; parse?: unknown };
      if (tool.definition && typeof tool.parse === "function") return replace(tool.definition);
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => typeof v !== "function" && v !== undefined)
          .map(([k, v]) => [k, replace(v)]),
      );
    }
    return item;
  };
  return replace(value) as ConfigFile;
}

function check(value: unknown, label: string): void {
  const problems = validate(value);
  if (problems.length > 0)
    throw new ConfigError(
      `${label} does not match the configuration schema:\n  ${problems.join("\n  ")}`,
    );
}

/** Only these variables can be interpolated, so a config cannot pull in TWIGG_API_KEY or CI secrets. */
export const VARIABLE_PREFIX = "TWIGG_VAR_";

/**
 * Substitute ${TWIGG_VAR_NAME} in every string. `$${NAME}` stays as a literal `${NAME}`. Other
 * names are refused: plan output is often posted to pull requests, and published config is
 * readable by everyone with access to the organisation.
 */
export function interpolate(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string")
    return value.replace(/\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      if (match.startsWith("$$")) return match.slice(1);
      if (!name.startsWith(VARIABLE_PREFIX))
        throw new ConfigError(
          `\${${name}}: only variables named ${VARIABLE_PREFIX}* can be used in a config file`,
        );
      const found = env[name];
      if (found === undefined) throw new ConfigError(`\${${name}} is not set in the environment`);
      return found;
    });
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}

async function resolveScope(scope: Scope, dir: string): Promise<DesiredScope> {
  const desired: DesiredScope = {};
  if (scope.instructions === null) desired.instructions = null;
  else if (scope.instructions !== undefined) {
    const value = scope.instructions;
    const longhand = typeof value === "object" && "body" in value;
    desired.instructions = {
      mode: (longhand && value.mode) || "append",
      body: await text(longhand ? value.body : (value as Text), dir),
    };
  }
  if (scope.tools === null) desired.tools = null;
  else if (scope.tools !== undefined) {
    const definitions: ToolDefinition[] = [];
    for (const item of scope.tools.definitions) {
      const loaded = isFile(item) ? await data(item, dir) : item;
      for (const definition of Array.isArray(loaded) ? loaded : [loaded])
        definitions.push(definition as ToolDefinition);
    }
    desired.tools = { mode: scope.tools.mode ?? "append", definitions };
  }
  if (scope.budgets === null) desired.budgets = null;
  else if (scope.budgets !== undefined) {
    const budgets: Record<string, ContextBudget> = {};
    for (const [key, value] of Object.entries(scope.budgets))
      if (value !== null)
        budgets[key] = (isFile(value) ? await data(value, dir) : value) as ContextBudget;
    desired.budgets = budgets;
  }
  if (scope.retention === null) desired.retention = null;
  else if (scope.retention !== undefined)
    desired.retention = (
      isFile(scope.retention) ? await data(scope.retention, dir) : scope.retention
    ) as RetentionRules;
  // What the files held must be valid too.
  check({ version: 1, global: toFileShape(desired) }, "A file this configuration loads");
  return desired;
}

/** A desired scope back in the file's shape, for validation and for writing. */
export function toFileShape(scope: DesiredScope): Scope {
  const shape: Scope = {};
  if (scope.instructions !== undefined) shape.instructions = scope.instructions;
  if (scope.tools !== undefined) shape.tools = scope.tools;
  if (scope.budgets !== undefined) shape.budgets = scope.budgets;
  if (scope.retention !== undefined) shape.retention = scope.retention;
  return shape;
}

function isFile(value: unknown): value is FileReference {
  return !!value && typeof value === "object" && typeof (value as FileReference).$file === "string";
}

async function text(value: Text, dir: string): Promise<string> {
  if (typeof value === "string") return value;
  return readReferenced(value, dir);
}

async function data(reference: FileReference, dir: string): Promise<unknown> {
  const content = await readReferenced(reference, dir);
  try {
    return extname(reference.$file).toLowerCase() === ".json"
      ? JSON.parse(content)
      : YAML.parse(content);
  } catch (error) {
    throw new ConfigError(`${reference.$file} is not valid JSON or YAML: ${message(error)}`);
  }
}

async function readReferenced(reference: FileReference, dir: string): Promise<string> {
  const path = resolve(dir, reference.$file);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read $file ${reference.$file}: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
