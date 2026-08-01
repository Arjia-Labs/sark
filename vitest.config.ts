import { defineConfig } from "vitest/config";

/**
 * Plain-node unit tests. The Durable Object tests need a real workerd runtime and live
 * in their own project (see vitest.workspace.ts), so this include is deliberately
 * non-recursive - `test/do/**` must not be picked up here.
 */
export default defineConfig({
  test: {
    name: "node",
    include: ["test/*.test.ts"],
    environment: "node",
  },
});
