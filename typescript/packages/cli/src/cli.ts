#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run } from "./main.js";

const interactive = process.stdin.isTTY && process.stdout.isTTY;

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
  ...(interactive
    ? {
        confirm: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(`${question} [y/N] `);
          rl.close();
          return /^y(es)?$/i.test(answer.trim());
        },
      }
    : {}),
});
