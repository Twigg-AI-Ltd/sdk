// Writing configuration files: YAML with the schema comment, or TypeScript with defineConfig.
import type { ToolDefinition } from "@twigg/sdk";
import YAML from "yaml";
import type { ModelNames, RemoteScope } from "./remote.js";
import { SCHEMA_URL } from "./schema.js";
import type { ConfigFile, Scope, ScopeKey } from "./types.js";

export type Format = "yaml" | "ts" | "json";

export function serialise(config: ConfigFile, format: Format): string {
  const { $schema: _, ...body } = config;
  if (format === "yaml")
    return `# yaml-language-server: $schema=${SCHEMA_URL}\n${YAML.stringify(body, { lineWidth: 0 })}`;
  if (format === "json") return `${JSON.stringify({ $schema: SCHEMA_URL, ...body }, null, 2)}\n`;
  const json = JSON.stringify(body, null, 2).replace(
    /\{\s*"\$file":\s*("(?:[^"\\]|\\.)*")\s*\}/g,
    (_match, path: string) => `file(${path})`,
  );
  const imports = json.includes("file(") ? "defineConfig, file" : "defineConfig";
  return `import { ${imports} } from "@twigg/cli";\n\nexport default defineConfig(${json});\n`;
}

/** Where a scope's pulled instructions are written, relative to the configuration file. */
export function promptPath(scope: ScopeKey): string {
  return scope === null ? "prompts/global.md" : `prompts/namespaces/${scope}.md`;
}

/** A remote scope in the file's shape. Instruction bodies become files, returned alongside. */
export function remoteToScope(
  scope: ScopeKey,
  remote: RemoteScope,
  models: ModelNames,
): { scope: Scope; files: [string, string][] } {
  const out: Scope = {};
  const files: [string, string][] = [];
  if (remote.instructions) {
    const path = promptPath(scope);
    files.push([path, `${remote.instructions.body.replace(/\s+$/, "")}\n`]);
    const mode = remote.instructions.mode ?? "append";
    out.instructions =
      scope !== null && mode === "replace" ? { mode, body: { $file: path } } : { $file: path };
  }
  if (remote.tools)
    out.tools = {
      ...(remote.tools.mode && remote.tools.mode !== "append" ? { mode: remote.tools.mode } : {}),
      definitions: remote.tools.definitions.map(tidyTool),
    };
  if (remote.budgets.length > 0)
    out.budgets = Object.fromEntries(remote.budgets.map((b) => [models.key(b.modelId), b.budget]));
  if (remote.retention) out.retention = remote.retention.rules;
  return { scope: out, files };
}

function tidyTool(definition: ToolDefinition): ToolDefinition {
  const out: ToolDefinition = { name: definition.name, input_schema: definition.input_schema };
  if (definition.description) out.description = definition.description;
  if (definition.strict !== null && definition.strict !== undefined) out.strict = definition.strict;
  return out;
}
