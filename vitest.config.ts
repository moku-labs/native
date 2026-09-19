import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "src/plugins/**/__tests__/unit/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "integration",
          include: [
            "tests/integration/**/*.test.ts",
            "src/plugins/**/__tests__/integration/**/*.test.ts"
          ]
        }
      },
      {
        // Real-toolchain proof (A13). Opt-in only: `bun run test:smoke`, never `bun run test`
        // — it drives a real `tauri build` (cargo compiles from scratch on a cold cache),
        // so the budget is 30 minutes and the files run one at a time to keep a single
        // Cargo target/ lock uncontended.
        test: {
          name: "smoke",
          include: ["tests/smoke/**/*.test.ts"],
          testTimeout: 30 * 60 * 1000,
          hookTimeout: 30 * 60 * 1000,
          fileParallelism: false
        }
      }
    ],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/**/types/**", "src/**/__tests__/**"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 }
    }
  }
});
