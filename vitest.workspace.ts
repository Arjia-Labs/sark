import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Two projects, one `vitest run`:
 *
 * - "node"    - the fast unit tests, unchanged (vitest.config.ts).
 * - "workers" - the ThreadSession Durable Object tests, running inside workerd against
 *               real DO storage and real alarms. Only this project pays the workerd
 *               startup cost, and only for `test/do/**`.
 */
export default [
  "./vitest.config.ts",
  defineWorkersProject({
    test: {
      name: "workers",
      include: ["test/do/**/*.test.ts"],
      poolOptions: {
        workers: {
          // Off deliberately. These sessions schedule real alarms, and an alarm that
          // fires a moment after the test that armed it would touch storage the
          // per-test teardown had already unwound. Isolation comes from every test
          // addressing a fresh, uniquely-named thread instead.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Secrets are not in wrangler.jsonc (they are `wrangler secret`s in prod).
            bindings: {
              BOX_API_KEY: "test-box-key",
              MCP_TOKEN_SECRET: "test-mcp-secret",
              API_TOKEN: "test-api-token",
            },
          },
        },
      },
    },
  }),
];
