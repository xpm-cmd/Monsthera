import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    exclude: ["tests/benchmark/**"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["node_modules/", "tests/", "dist/", "**/*.d.ts"],
      // Ratchet floors: set at-or-just-below current real coverage so it can
      // only go up, never silently regress. These are NOT the 80/70 aspiration —
      // raise each floor as coverage improves. Ratcheted 2026-06-11 after the
      // F2 CLI-command backfill (real: lines 74.34 / functions 83.13 /
      // branches 62.96).
      thresholds: {
        lines: 74,
        functions: 82,
        branches: 62,
      },
    },
  },
});
