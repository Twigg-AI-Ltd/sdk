// Pins the API contracts the SDKs are built against.
//
//   node scripts/sync-spec.mjs [path/to/twigg-api]   copy from a local checkout (default ../twigg-api)
//   node scripts/sync-spec.mjs --check               compare the pinned copies with what is live
//
// The copies live in spec/ so a build never depends on the network, and spec/SOURCE records
// which twigg-api commit they came from. --check compares parsed JSON, so formatting differences
// between the checked-in snapshot and the served document do not count as drift.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contracts = [
  {
    file: "spec/openapi.json",
    source: "backend/src/routes/openapi.json",
    live: "https://api.twigg.ai/openapi.json",
  },
  {
    file: "spec/config.v1.json",
    source: "frontend/public/schemas/config.v1.json",
    live: "https://twigg.ai/schemas/config.v1.json",
  },
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const contract of contracts) {
    const pinned = JSON.parse(await readFile(resolve(root, contract.file), "utf8"));
    const response = await fetch(contract.live);
    if (!response.ok) {
      console.error(`${contract.live}: HTTP ${response.status}`);
      stale = true;
      continue;
    }
    // twigg.ai answers unknown paths with the SPA's index.html and a 200, not a 404.
    if (!response.headers.get("content-type")?.includes("json")) {
      console.error(`${contract.live}: not served (got ${response.headers.get("content-type")})`);
      stale = true;
      continue;
    }
    const live = await response.json();
    if (canonical(live) === canonical(pinned)) console.log(`${contract.file} matches ${contract.live}`);
    else {
      console.error(`${contract.file} differs from ${contract.live}; run node scripts/sync-spec.mjs`);
      stale = true;
    }
  }
  process.exitCode = stale ? 1 : 0;
} else {
  const api = resolve(process.argv[2] ?? resolve(root, "../twigg-api"));
  const git = (...args) => execFileSync("git", ["-C", api, ...args], { encoding: "utf8" }).trim();
  for (const contract of contracts) {
    await writeFile(resolve(root, contract.file), await readFile(resolve(api, contract.source)));
    console.log(`${contract.source} -> ${contract.file}`);
  }
  const dirty = git("status", "--porcelain", "--", ...contracts.map((c) => c.source)) !== "";
  const source = `${git("rev-parse", "HEAD")}${dirty ? " (with uncommitted changes)" : ""}\n`;
  await writeFile(resolve(root, "spec/SOURCE"), source);
  console.log(`spec/SOURCE: ${source.trim()}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
