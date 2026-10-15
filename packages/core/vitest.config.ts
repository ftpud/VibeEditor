import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // These integration tests spawn real Core/provider processes and native PTYs.
    // Match the small hosted CI runners instead of oversubscribing their CPUs.
    maxWorkers: 2,
  },
});
