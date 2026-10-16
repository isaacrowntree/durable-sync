/** Opt-in integration suite: the journal inside a real Durable Object, on the
 * SQLite that actually ships. `npm test` never runs this — it's `npm run
 * test:integration`, because it boots workerd and is an order of magnitude
 * slower than the unit tests.
 *
 * The unit suite (MemoryOpStore, and SqlOpStore over node:sqlite) proves the
 * logic and that the SQL parses. This proves the SQL runs where it's deployed:
 * DO SQLite, reached through the journal's own RPC methods. */
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// @cloudflare/vitest-plugin is the renamed @cloudflare/vitest-pool-workers:
// the same Vite plugin and options, on the line that supports Vitest 5.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Storage resets between tests, so each one seeds its own log.
      isolatedStorage: true,
      wrangler: { configPath: "./test/integration/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
  },
});
