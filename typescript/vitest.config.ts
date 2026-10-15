import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to each other's TypeScript source, so tests need no build first.
  // Tests run as server code, which takes its conditions from `ssr`, so set both.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
