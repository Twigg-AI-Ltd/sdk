// Plans must not flap, so both sides of every comparison go through these first.
import type { ToolDefinition } from "@twigg/sdk";

/** Line endings to \n and trailing whitespace at the end trimmed. Inner whitespace is meaning. */
export function normaliseBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** Sorted by name, with `strict: null` and `description: null` read as absent. */
export function normaliseTools(definitions: ToolDefinition[]): string {
  const tidy = definitions
    .map((d) => {
      const out: Record<string, unknown> = { name: d.name, input_schema: d.input_schema };
      if (d.description !== null && d.description !== undefined) out.description = d.description;
      if (d.strict !== null && d.strict !== undefined) out.strict = d.strict;
      return out;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return canonical(tidy);
}

/** A document compared after filling in the platform defaults it left out. */
export function normaliseDocument(document: unknown, defaults: unknown): string {
  return canonical(tidyFloats(merge(defaults, document)));
}

/**
 * Twigg stores budget and retention fractions as 32-bit floats, so `0.15` comes back as
 * `0.15000000596046448`. Every non-integer becomes the shortest decimal with the same 32-bit
 * value, on both sides of a comparison and in pulled files.
 */
export function tidyFloats<T>(value: T): T {
  if (typeof value === "number") return (Number.isInteger(value) ? value : shortest(value)) as T;
  if (Array.isArray(value)) return value.map(tidyFloats) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidyFloats(v)])) as T;
  return value;
}

function shortest(value: number): number {
  const target = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === target) return candidate;
  }
  return value;
}

/** JSON with object keys sorted, so key order never counts as a change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Deep merge of plain objects; arrays and scalars in `over` replace those in `base`. */
export function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Lines added and removed between two texts, counted as multisets. */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

/** A rough token count for display: four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
