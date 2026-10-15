// Validation against the configuration schema shipped with the package, a copy of
// https://twigg.ai/schemas/config.v1.json kept identical to spec/config.v1.json by a test.
import { readFileSync } from "node:fs";
import ajvModule from "ajv/dist/2020.js";

/** The schema's location inside the package, from both src/ and dist/. */
export const SCHEMA_PATH = new URL("../schema/config.v1.json", import.meta.url);
export const SCHEMA_URL = "https://twigg.ai/schemas/config.v1.json";

type Validator = ((value: unknown) => boolean) & {
  errors?:
    | {
        instancePath: string;
        schemaPath: string;
        keyword: string;
        message?: string;
        params: Record<string, unknown>;
      }[]
    | null;
};

let compiled: Validator | undefined;

/** Problems with `value` as a configuration file, as readable lines. Empty when valid. */
export function validate(value: unknown): string[] {
  compiled ??= compile();
  if (compiled(value)) return [];
  const errors = compiled.errors ?? [];
  // An anyOf reports every alternative that failed, so one mistake in a budget also shows up as
  // "must be null" and "must have $file" beside the real complaint. Drop the alternatives the
  // value plainly was not meant to be: a `$file` reference without a `$file` key, `null` when
  // something else also failed there, and anything a deeper error already explains.
  const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const anyOfs = errors.filter((e) => e.keyword === "anyOf").map((e) => e.instancePath);
  const deepest = errors.filter((error) => {
    if (error.keyword === "anyOf") return false;
    if (!anyOfs.some((root) => within(error.instancePath, root))) return true;
    if (error.schemaPath.startsWith("#/$defs/FileReference")) {
      // The reference object itself, also when the error is about its `$file` value.
      const path = error.instancePath.endsWith("/$file")
        ? error.instancePath.slice(0, -"/$file".length)
        : error.instancePath;
      if (!hasKey(pointer(value, path), "$file")) return false;
    }
    const others = errors.filter((o) => o !== error && o.keyword !== "anyOf");
    if (error.keyword === "type" && others.some((o) => o.instancePath === error.instancePath))
      return false;
    return !others.some((o) => o.instancePath.startsWith(`${error.instancePath}/`));
  });
  const lines = deepest.map((error) => {
    const at = error.instancePath || "/";
    const name = error.params.propertyName ?? error.params.additionalProperty;
    const allowed = error.params.allowedValues as unknown[] | undefined;
    const message = error.message ?? "is invalid";
    return `${at}${name ? ` (${String(name)})` : ""}: ${message}${allowed ? ` (${allowed.map((v) => JSON.stringify(v)).join(", ")})` : ""}`;
  });
  return [...new Set(lines)].slice(0, 8);
}

/** The value at a JSON pointer such as `/namespaces/acme`, or undefined. */
function pointer(root: unknown, path: string): unknown {
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      root,
    );
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value;
}

function compile(): Validator {
  // ajv ships CommonJS; its class is the default export under some loaders and the module itself
  // under others.
  const Ajv = ((ajvModule as unknown as { default?: unknown }).default ?? ajvModule) as new (
    options: Record<string, unknown>,
  ) => { compile(schema: unknown): Validator };
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
  // The surface schemas carry OpenAPI formats such as int32 that JSON Schema does not define.
  return new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false }).compile(
    schema,
  );
}
