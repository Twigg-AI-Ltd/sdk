// `twigg config ...`: argument parsing, the commands, and their exit codes. Exit 0 means no
// changes, 2 means changes were planned or made, 1 means an error.
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type ConfigVersion, Twigg, TwiggError } from "@twigg/sdk";
import YAML from "yaml";
import { resolveCredentials } from "./credentials.js";
import { ConfigError, DEFAULT_FILES, loadConfig, readRaw } from "./load.js";
import { apply, DriftError, plan, scopeOrder, scopesInPlay } from "./plan.js";
import { type Context, context, fetchRemote, hasOverrides, scopeQuery } from "./remote.js";
import { renderApplied, renderPlan } from "./render.js";
import { type ConfigFile, type ScopeKey, SURFACES, type Surface, scopeLabel } from "./types.js";
import { type Format, remoteToScope, serialise } from "./write.js";

export const EXIT = { ok: 0, error: 1, changes: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Ask a yes/no question. Absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

const HELP = `Usage: twigg config <command> [options]

Commands:
  plan       Show what applying the configuration file would change
  apply      Publish and withdraw to match the configuration file
  pull       Write the current configuration as a file
  rollback   Restore the previous version of one surface
  resolve    Show the effective configuration for a scope, after inheritance
  history    List versions, with the active one marked
  validate   Check a configuration file against the schema, offline
  convert    Rewrite a configuration file in another format

Options:
  -c, --config <path>   Configuration file (default: twigg.config.{ts,yaml,yml,json})
  --scope <namespace>   Only this namespace and everything beneath it (default: everything;
                        for rollback, resolve and history: the organisation-wide scope)
  --prune               With --scope: withdraw overrides beneath it that the file does not mention
  --prune-all           Withdraw overrides in every scope the file does not mention, across the
                        whole organisation
  --yes                 Apply without asking
  --json                Machine-readable output
  --detailed-exitcode   plan only: exit 2 when there are changes, 0 when there are none
  --report <path>       Write what apply did as JSON
  --format <yaml|ts|json>  Output format for pull and convert (default yaml)
  --out <path>          Output file for pull and convert
  --force               Overwrite existing files on pull
  --surface <name>      instructions, tools, budgets or retention
  --model <name>        A budget's model, for rollback and history (default: the scope default)
  --to <version>        The version number to roll back to (default: the previous one)
  --profile <name>      A profile from ~/.config/twigg/credentials
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes: 0 success, 1 error. With plan --detailed-exitcode: 0 no changes, 2 changes, 1 error.`;

const OPTIONS = {
  config: { type: "string", short: "c" },
  scope: { type: "string" },
  prune: { type: "boolean" },
  "prune-all": { type: "boolean" },
  "detailed-exitcode": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  report: { type: "string" },
  format: { type: "string" },
  out: { type: "string" },
  force: { type: "boolean" },
  surface: { type: "string" },
  model: { type: "string" },
  to: { type: "string" },
  profile: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

export async function run(argv: string[], io: Io): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${HELP}`);
    return EXIT.error;
  }
  const { values: flags, positionals } = args;
  if (flags.version) {
    io.stdout(VERSION);
    return EXIT.ok;
  }
  const [group, command] = positionals;
  if (flags.help || group !== "config" || !command) {
    (flags.help ? io.stdout : io.stderr)(HELP);
    return flags.help ? EXIT.ok : EXIT.error;
  }
  try {
    switch (command) {
      case "plan":
        return await planCommand(flags, io);
      case "apply":
        return await applyCommand(flags, io);
      case "pull":
        return await pullCommand(flags, io);
      case "rollback":
        return await rollbackCommand(flags, io);
      case "resolve":
        return await resolveCommand(flags, io);
      case "history":
        return await historyCommand(flags, io);
      case "validate":
        return await validateCommand(flags, io);
      case "convert":
        return await convertCommand(flags, io);
      default:
        io.stderr(`Unknown command: config ${command}\n\n${HELP}`);
        return EXIT.error;
    }
  } catch (error) {
    io.stderr(describe(error));
    return EXIT.error;
  }
}

export const VERSION = "0.1.0";

async function client(flags: Flags, io: Io): Promise<Twigg> {
  const credentials = await resolveCredentials(flags.profile, io.env);
  if (!credentials.apiKey)
    throw new ConfigError(
      "No API key. Set TWIGG_API_KEY or add a profile to ~/.config/twigg/credentials.",
    );
  return new Twigg({
    apiKey: credentials.apiKey,
    ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
}

async function configPath(flags: Flags, io: Io): Promise<string> {
  if (flags.config) return resolve(io.cwd, flags.config);
  for (const name of DEFAULT_FILES) {
    const path = resolve(io.cwd, name);
    if (await exists(path)) return path;
  }
  throw new ConfigError(
    `No configuration file found; pass -c or create ${DEFAULT_FILES.join(", ")}`,
  );
}

async function planCommand(flags: Flags, io: Io): Promise<number> {
  const config = await loadConfig(await configPath(flags, io), io.env);
  const ctx = await context(await client(flags, io));
  const planned = await plan(ctx, config.desired, options(flags));
  io.stdout(flags.json ? JSON.stringify(planned, null, 2) : renderPlan(planned));
  const changed = planned.counts.publish + planned.counts.withdraw > 0;
  return flags["detailed-exitcode"] && changed ? EXIT.changes : EXIT.ok;
}

async function applyCommand(flags: Flags, io: Io): Promise<number> {
  const config = await loadConfig(await configPath(flags, io), io.env);
  const ctx = await context(await client(flags, io));
  const planned = await plan(ctx, config.desired, options(flags));
  if (!flags.json) io.stdout(renderPlan(planned));
  if (planned.counts.publish + planned.counts.withdraw === 0) {
    if (flags.json) io.stdout(JSON.stringify({ applied: [] }, null, 2));
    return EXIT.ok;
  }
  if (!flags.yes) {
    if (!io.confirm) throw new ConfigError("Not running in a terminal; pass --yes to apply");
    if (!(await io.confirm("Apply these changes?"))) {
      io.stderr("Nothing applied.");
      return EXIT.error;
    }
  }
  const applied: Awaited<ReturnType<typeof apply>> = [];
  const writeReport = async (failure?: string) => {
    if (flags.report)
      await writeFile(
        resolve(io.cwd, flags.report),
        `${JSON.stringify({ applied, ...(failure ? { error: failure } : {}) }, null, 2)}\n`,
      );
  };
  try {
    await apply(ctx, planned, (done) => {
      applied.push(done);
      if (!flags.json) io.stdout(renderApplied(done));
    });
  } catch (error) {
    await writeReport(describe(error));
    if (error instanceof DriftError && error.applied.length === 0)
      throw new ConfigError(`${error.message}. Nothing was applied.`);
    throw error;
  }
  await writeReport();
  if (flags.json) io.stdout(JSON.stringify({ applied }, null, 2));
  else io.stdout(`Applied ${applied.length} change${applied.length === 1 ? "" : "s"}.`);
  return EXIT.ok;
}

async function pullCommand(flags: Flags, io: Io): Promise<number> {
  const format = outputFormat(flags);
  const out = resolve(io.cwd, flags.out ?? `twigg.config.${format}`);
  const ctx = await context(await client(flags, io));
  const scopes = await scopesInPlay(ctx, [], flags.scope);
  const remote = await fetchRemote(ctx.twigg, scopes);
  const config: ConfigFile = { version: 1 };
  const files: [string, string][] = [];
  for (const scope of scopes.sort(scopeOrder)) {
    const now = remote.get(scope);
    if (!now || !hasOverrides(now)) continue;
    const pulled = remoteToScope(scope, now, ctx.models, ctx.defaults);
    files.push(...pulled.files);
    if (scope === null) config.global = pulled.scope;
    else {
      config.namespaces ??= {};
      config.namespaces[scope] = pulled.scope;
    }
  }
  const outputs: [string, string][] = [
    [out, serialise(config, format)],
    ...files.map(([path, text]): [string, string] => [resolve(dirname(out), path), text]),
  ];
  if (!flags.force)
    for (const [path] of outputs)
      if (await exists(path)) throw new ConfigError(`${path} exists; pass --force to overwrite`);
  for (const [path, text] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  io.stdout(`Wrote ${outputs.map(([path]) => path).join(", ")}`);
  return EXIT.ok;
}

async function rollbackCommand(flags: Flags, io: Io): Promise<number> {
  const surface = requireSurface(flags);
  const ctx = await context(await client(flags, io));
  const scope: ScopeKey = flags.scope ?? null;
  const versions = await listVersions(ctx, scope, surface, flags.model);
  const active = versions.find((v) => v.is_active);
  const target = flags.to
    ? versions.find((v) => v.version === Number(flags.to))
    : active
      ? versions.filter((v) => v.version < active.version).sort((a, b) => b.version - a.version)[0]
      : undefined;
  if (!target)
    throw new ConfigError(
      flags.to
        ? `No version ${flags.to} of ${surface} in ${scopeLabel(scope)}`
        : active
          ? `${surface} in ${scopeLabel(scope)} has no version before v${active.version}`
          : `Nothing is active for ${surface} in ${scopeLabel(scope)}; pass --to <version>`,
    );
  if (target.is_active) {
    io.stdout(`${surface} in ${scopeLabel(scope)} is already at v${target.version}.`);
    return EXIT.ok;
  }
  const config = ctx.twigg.config;
  if (surface === "instructions") await config.instructions.restore(target.id);
  else if (surface === "tools") await config.tools.restore(target.id);
  else if (surface === "budgets") await config.budgets.restore(target.id);
  else await config.retention.restore(target.id);
  io.stdout(
    `Restored ${surface} in ${scopeLabel(scope)} to v${target.version}${active ? ` (was v${active.version})` : ""}.`,
  );
  return EXIT.ok;
}

async function resolveCommand(flags: Flags, io: Io): Promise<number> {
  const twigg = await client(flags, io);
  const resolved = await twigg.config.resolve(scopeQuery(flags.scope ?? null));
  if (flags.json) io.stdout(JSON.stringify(resolved, null, 2));
  else
    io.stdout(
      [
        `Scope: ${scopeLabel(flags.scope ?? null)}  (~${resolved.estimated_tokens} tokens)`,
        "",
        "Instructions:",
        resolved.instructions ? indent(resolved.instructions) : "  (none)",
        "",
        `Tools: ${resolved.tools.map((t) => t.name).join(", ") || "(none)"}`,
        "",
        // A policy is shown in full; the platform default only by name, since it is long.
        resolved.versions.retention_policy
          ? `Retention: policy ${resolved.versions.retention_policy}\n${indent(YAML.stringify(resolved.retention).trimEnd())}`
          : "Retention: platform default (--json shows it)",
      ].join("\n"),
    );
  return EXIT.ok;
}

async function historyCommand(flags: Flags, io: Io): Promise<number> {
  const ctx = await context(await client(flags, io));
  const scope: ScopeKey = flags.scope ?? null;
  const surfaces = flags.surface ? [requireSurface(flags)] : SURFACES;
  const all: Record<string, ConfigVersion[]> = {};
  for (const surface of surfaces)
    all[surface] = await listVersions(ctx, scope, surface, flags.model);
  if (flags.json) {
    io.stdout(JSON.stringify(all, null, 2));
    return EXIT.ok;
  }
  const lines = [`Scope: ${scopeLabel(scope)}`];
  for (const surface of surfaces) {
    lines.push("", surface);
    const versions = (all[surface] ?? []).sort((a, b) => b.version - a.version);
    if (versions.length === 0) lines.push("  (no versions)");
    for (const v of versions)
      lines.push(
        `  ${v.is_active ? "*" : " "} v${String(v.version).padEnd(4)} ${v.created_at}  ${v.mode ?? ""}${
          v.estimated_tokens ? `  ~${v.estimated_tokens} tokens` : ""
        }  ${v.id}`,
      );
  }
  io.stdout(lines.join("\n"));
  return EXIT.ok;
}

async function validateCommand(flags: Flags, io: Io): Promise<number> {
  const path = await configPath(flags, io);
  const config = await loadConfig(path, io.env);
  const scopes = [...config.desired.keys()].map(scopeLabel);
  io.stdout(
    `${path} is valid: ${scopes.length} scope${scopes.length === 1 ? "" : "s"} (${scopes.join(", ") || "none"}).`,
  );
  return EXIT.ok;
}

async function convertCommand(flags: Flags, io: Io): Promise<number> {
  const raw = await readRaw(await configPath(flags, io));
  const text = serialise(raw, outputFormat(flags));
  if (flags.out) {
    await writeFile(resolve(io.cwd, flags.out), text);
    io.stdout(`Wrote ${flags.out}`);
  } else io.stdout(text.trimEnd());
  return EXIT.ok;
}

/** Versions of one surface in one scope; budgets for one model, or the scope default. */
async function listVersions(
  ctx: Context,
  scope: ScopeKey,
  surface: Surface,
  model: string | undefined,
): Promise<ConfigVersion[]> {
  const ns = scopeQuery(scope);
  const config = ctx.twigg.config;
  switch (surface) {
    case "instructions":
      return config.instructions.versions(ns);
    case "tools":
      return config.tools.versions(ns);
    case "retention":
      return config.retention.versions(ns);
    case "budgets": {
      const modelId = ctx.models.id(model ?? "default");
      const versions = await config.budgets.versions(modelId ? { ...ns, model: modelId } : ns);
      return versions.filter((v) => (v.model_id ?? null) === modelId);
    }
  }
}

function options(flags: Flags) {
  // Pruning the whole organisation withdraws every override the file does not mention, so it
  // takes its own flag rather than following from a forgotten --scope.
  if (flags["prune-all"] && flags.scope)
    throw new ConfigError(
      "--prune-all prunes the whole organisation; to prune beneath one namespace, use --prune with --scope",
    );
  if (flags.prune && !flags.scope)
    throw new ConfigError(
      "--prune without --scope would withdraw configuration from every scope in the organisation that this file does not mention. Pass --scope <namespace> to prune beneath one namespace, or --prune-all if you mean the whole organisation.",
    );
  return {
    ...(flags.scope ? { scope: flags.scope } : {}),
    prune: !!flags.prune || !!flags["prune-all"],
  };
}

function outputFormat(flags: Flags): Format {
  const format = flags.format ?? (flags.out ? formatOf(flags.out) : "yaml");
  if (format !== "yaml" && format !== "ts" && format !== "json")
    throw new ConfigError(`--format must be yaml, ts or json, not ${format}`);
  return format;
}

function formatOf(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return extension === "yml" ? "yaml" : extension === "mts" ? "ts" : extension;
}

function requireSurface(flags: Flags): Surface {
  const surface = flags.surface as Surface | undefined;
  if (!surface || !SURFACES.includes(surface))
    throw new ConfigError(`--surface must be one of ${SURFACES.join(", ")}`);
  return surface;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function describe(error: unknown): string {
  if (error instanceof TwiggError)
    return `${error.message}${error.code ? ` (${error.code})` : ""}${error.hint ? `\n${error.hint}` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
