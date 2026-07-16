/** Opt-in integration suite: the journal inside a real Durable Object, on the
 * SQLite that actually ships. `npm test` never runs this — it's `npm run
 * test:integration`, because it boots workerd and is an order of magnitude
 * slower than the unit tests.
 *
 * The unit suite (MemoryOpStore, and SqlOpStore over node:sqlite) proves the
 * logic and that the SQL parses. This proves the SQL runs where it's deployed:
 * DO SQLite, through the DO's own fetch routing. */
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The pool is a Vite plugin as of 0.18 (the vitest-4 line); the older
// `defineWorkersConfig` / `poolOptions` entrypoint is gone. Same options,
// different door.
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
