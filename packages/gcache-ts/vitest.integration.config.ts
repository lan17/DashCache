import { defineConfig } from "vitest/config";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
