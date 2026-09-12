import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Keep compiled production output out of the test graph. A CommonJS build
    // of a Vitest test cannot import Vitest's ESM-only entry point.
    include: ["src/**/*.test.ts"],
    env: {
      AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
