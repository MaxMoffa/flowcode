import { defineConfig } from "vitest/config";

// Pure-logic tests only (no DOM). The phone's modules import from the root
// node_modules, so one runner covers both apps.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "sdk/**/*.test.ts", "mobile/src/**/*.test.ts"],
  },
});
