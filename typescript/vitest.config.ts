import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to each other's TypeScript source, so tests need no build first.
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
