# Contributing

## Tests

Two suites. The first is the one you run constantly; the second is opt-in.

```bash
npm test               # unit — the logic, and the SQL over node:sqlite
npm run test:integration   # the journal inside a real Durable Object
```

**Unit** (`src/**/*.test.ts`) is instant. It covers `MemoryOpStore`, and
`SqlOpStore` against real SQLite via Node's built-in `node:sqlite` — enough to
prove the statements parse and the constraints hold.

**Integration** (`test/integration/`) boots `workerd` through
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and drives every route against the DO's own SQLite, through its own `fetch`
routing. It's what catches a divergence between `node:sqlite` and the SQLite
that actually ships. It's an order of magnitude slower, so it's kept out of
`npm test` and off the push/PR CI — run it by hand, or trigger the `integration`
workflow from the Actions tab.

The DO is a singleton per name and per-test storage isolation doesn't roll its
SQLite back here, so each test starts with `DELETE /reset` for a clean log.

### Local setup gotcha

The pool pulls in `sharp` (via `wrangler`), whose prebuilt binaries don't yet
cover the newest Node. Install and run the integration suite on **Node 22** —
the version CI uses. If a first `npm install` fails building `sharp` from
source, `npm install --ignore-scripts` skips it; the pool's `workerd` and
`esbuild` binaries come from platform packages that need no build step.

## Publishing

`prepublishOnly` runs the unit suite and the build — never the integration
suite, which needs a runtime the publish box may not have. Releases go out by
tag; see the top of `.github/workflows/publish.yml`.
