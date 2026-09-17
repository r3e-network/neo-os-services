import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      all: true,
      exclude: [
        "**/*.test.ts",
        "**/dist/**",
        "**/node_modules/**",
        "src/**/index.ts",
        "**/*.d.ts",
        "vitest.config.*",
      ],
    },
  },
});
