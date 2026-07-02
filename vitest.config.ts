import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// serialize.ts imports parseYaml from "obsidian", which has no runtime outside
// the app - alias it to a js-yaml-backed stub (js-yaml is what Obsidian uses).
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
