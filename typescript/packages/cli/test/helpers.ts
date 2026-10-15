import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { type Io, run } from "../src/main.js";
import type { fakeApi } from "./fake-api.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temporary project directory holding `files`. */
export async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "twigg-cli-test-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

export function read(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), "utf8");
}

/** Run the CLI in `dir` against the fake API, capturing output. */
export async function cli(
  api: ReturnType<typeof fakeApi>,
  dir: string,
  argv: string[],
  extra: Partial<Io> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { TWIGG_API_KEY: "tw_test", HOME: dir },
    cwd: dir,
    fetch: api.fetch,
    ...extra,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}
