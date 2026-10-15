import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ResponseAccumulator } from "../src/streaming/result.js";
import { parseSse } from "../src/streaming/sse.js";
import type { ResponseEvent } from "../src/types.js";
import { toConformance } from "./conformance.js";
import { chunked } from "./helpers.js";

const dir = resolve(import.meta.dirname, "../../../../fixtures/streams");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".sse"))
  .map((f) => f.slice(0, -4));

async function accumulate(text: string, chunkSize: number) {
  const accumulator = new ResponseAccumulator();
  for await (const frame of parseSse(chunked(text, chunkSize)))
    accumulator.push({ event: frame.event, data: JSON.parse(frame.data) } as ResponseEvent);
  return accumulator.result();
}

describe("recorded streams", () => {
  it("has fixtures", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s accumulates to its expected result at any chunk size", async (name) => {
    const sse = readFileSync(resolve(dir, `${name}.sse`), "utf8");
    const expectedPath = resolve(dir, `${name}.json`);
    const actual = toConformance(await accumulate(sse, 7));
    if (process.env.UPDATE_FIXTURES)
      writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(actual).toEqual(expected);
    for (const size of [1, 3, 64, 100_000])
      expect(toConformance(await accumulate(sse, size))).toEqual(expected);
    expect(toConformance(await accumulate(sse.replaceAll("\n", "\r\n"), 5))).toEqual(expected);
  });
});
