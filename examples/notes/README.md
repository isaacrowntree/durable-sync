# durable-sync · offline notes

The smallest real offline-first app: a notes list that keeps working with the
network off, on nothing but a Cloudflare Durable Object. It's here to show the
whole loop end to end — the server RPC, the durable outbox, the sync lifecycle —
without any of the app it was extracted from.

```bash
npm install
npm run dev      # wrangler dev → http://localhost:8787
```

Then: add a note, click **Offline**, add a few more (they queue in the outbox),
click **Online** — watch them drain and get their sequence numbers. Reload while
offline and the queued notes are still there, because the outbox is in
IndexedDB.

## What's where

| File | What it is |
|---|---|
| `worker.js` | The whole server. Exports the journal DO and forwards three HTTP routes to its RPC methods. Note what it *doesn't* route: `reset()`. |
| `public/app.js` | The browser client — a durable IndexedDB outbox, and `createSync` wiring it to `/api/sync`. |
| `public/index.html` | The page. |

The server surface is three method calls:

```js
const journal = env.JOURNAL.get(env.JOURNAL.idFromName("demo"));
await journal.push(ops);              // POST /api/sync
await journal.pull(since, snapshot);  // GET  /api/sync
await journal.putSnapshot(fold);      // PUT  /api/sync
```

`journal.reset()` exists on the DO and is never wired to a route — that's the
access model: a client can reach exactly what you forward.

## Not shown, on purpose

- **Auth.** One journal named `"demo"` serves everyone. A real app addresses it
  by the signed-in identity (`idFromName(userId)`), which is the isolation
  boundary.
- **The offline toggle is a demo device** — it flips `window.fetch` so you can
  watch the outbox fill without opening DevTools. Real offline needs nothing.

## Deploy it

```bash
npm run deploy   # needs a Cloudflare account: wrangler login
```
