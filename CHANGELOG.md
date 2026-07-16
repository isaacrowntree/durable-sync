# Changelog

## 0.3.0 — 2026-07-16

**Breaking, server only. The client is untouched — no client change is needed.**

`SyncJournal` is now a native Durable Object with typed RPC methods, instead of
a class with a `fetch` router. You call the journal the way you call any DO —
`await journal.push(ops)` — with no request-building, no string paths, and a
return type the compiler knows.

### Why

The old surface routed by HTTP method and pathname inside the DO. That put a
router between your Worker and the log that you didn't write and couldn't see,
and it leaned on `Request`/`Response` for a hop that never leaves your own
isolate. RPC is what that hop is for: the call is a method call, the access
model is just "a client reaches the methods you forward from a route," and
`reset()` is private because nothing routes to it — not because a router
special-cases `DELETE`.

### Migrate

`SyncJournal` now extends `DurableObject` from `cloudflare:workers`, so its
constructor takes `(ctx, env)` — which is what the runtime already passes a DO.
If you wrote `export class Journal extends SyncJournal {}` and nothing else, you
don't touch the class.

Your route handler changes from forwarding a `Request` to calling a method:

```ts
// before
return journal.fetch("https://journal/push", { method: "POST", body, headers });
// after
return Response.json(await journal.push(ops));
```

The four routes map to `push(ops)`, `pull(since, withSnapshot?)`,
`putSnapshot({ seq, epoch, blob })`, and `opsByKind(kind)`. `reset()` is there
too — don't route it. The removed `JournalState` type is gone; the DO takes the
real `DurableObjectState`.

The **wire protocol between client and server is unchanged** — same JSON on the
same routes — so a 0.3 server and a 0.2 client interoperate. Only the
Worker↔DO code shape moved.

### Also

- A runnable example: [`examples/notes`](examples/notes), a Worker plus a
  browser client with a real IndexedDB outbox, verified end to end.

## 0.2.0 — 2026-07-16

A silent-loss fix that needs no migration, and snapshots, which are opt-in.

### Fixed: a refused op was drained as if it had been stored

The same bug as trusting `res.ok`, one layer in. The journal refuses an op with
a blank `opId` or `kind` — and said so, in `accepted` — but the client drained
the whole outbox against any well-formed reply and never looked. The write was
gone, the sync reported clean, and the status row said `lastOkAt`. For a
package whose pitch is *the outbox may hold the only copy of a write*, this was
the last hole, and it was self-inflicted.

`handlePush` now returns `stored: string[]` — the opIds the log holds, whether
inserted just now or already present from a push whose reply got lost — and the
client drains exactly those. A count couldn't carry this: `accepted: 1` of two
ops means one stored and one *refused*, or one stored and one *duplicate*, and
those need opposite handling.

A client newer than its Worker sees no `stored` and keeps the old behaviour, so
a rollout where the PWA leads the Worker is not a regression.

### Added: snapshots, for logs that have got long

A pull replays every op after your cursor. That's free for a year and a real
wait after a few — tens of thousands of ops downloaded and applied before a new
device shows a single number, and again for every client after a reset.

The journal can't fold the log: it never reads a payload, which is what keeps it
a primitive. So a client folds and the journal stores the result opaquely.

- `snapshot?: SnapshotAdapter` on `createSync` — your `capture()` and
  `restore(blob)`. Omit it and nothing changes.
- `sync.capture()` — fold now. Nothing calls it for you; only your app knows
  when its state is settled rather than mid-edit. Behind `canWrite()`.
- `GET /pull?since=0&snapshot=1` returns `{ snapshot, ops }` where `ops` is the
  tail. Only a cold-start caller that asked ever gets one.
- `PUT /snapshot` `{ seq, epoch, blob }` → `{ ok, seq }`. Route it if you use
  snapshots.

The log is never pruned, so this is only ever an accelerator: `restore` can
return false — do that for a blob an older build wrote — and the client replays
the whole log, which is slow and always correct. The journal refuses a fold of
a generation that no longer exists, so a client that missed a reset can't undo
it for everyone else.

### Also

- `SqlOpStore` has tests now, against real SQLite via `node:sqlite`. It's what
  every production journal actually runs, and the suite only ever covered
  `MemoryOpStore` — so no constraint or upsert in it had ever been executed.

## 0.1.2 — 2026-07-16

No code changes. The README shipped two claims about `partysync` that don't
survive reading its source, and this is the release that stops publishing them.

- **`partysync` does not sync whole state.** It's delta sync: a timestamp
  cursor, changed rows only, soft deletes — and its client keeps an IndexedDB
  read cache, so it survives a refresh offline. The gap between it and this
  package is a write queue, and nothing else. It is the closest thing to this,
  and the README now says so.
- **"Maybe won't do" was quoted as if it were a statement about offline.** It's
  a section heading in partysync's README; offline sits under it as an open
  question. Reworded to describe what the README actually does.
- Zero doesn't do offline writes at all ("Zero is not local-first," in its own
  docs), so it's no longer listed among the engines you'd weigh this against
  for offline.
- Triplit is unmaintained rather than abandoned — unarchived, with open PRs —
  and Supabase acquired its co-founder, not the team.
- Electric rebranded; links point at `electric.ax`.
- Docs site: <https://isaacrowntree.com/durable-sync/>

## 0.1.1 — 2026-07-16

Metadata only — adds `homepage` and `bugs` so npm links somewhere useful. No
code changes.

## 0.1.0 — 2026-07-16

First release. Extracted from [Rampset](https://github.com/isaacrowntree/rampset),
which runs this design in production.

- **Server**: an append-only op log on Durable Object SQLite. Idempotent by
  `opId`, so a client that isn't sure its push landed can retry for free.
  Epochs, so a reset can't silently strand every client. A ready-made
  `SyncJournal` you extend and export.
- **Client**: a durable outbox, a per-device cursor, idempotent apply, and
  replay when the log reports a new epoch.
- **Lifecycle**: sync on `visibilitychange` / `pageshow` / `focus` / `online`
  plus a visible-only poll — single-flighted and throttled, because one
  foregrounding fires three of those at once.
- **Honesty**: a status you can show users that cannot claim success it didn't
  have.

### Why the odd-looking bits are there

Every non-obvious line in this package is a bug that shipped, in production, in
the app it came from:

- `res.ok` is not evidence — an expired auth-proxy session returns its login
  page as a same-origin **200**, and draining the outbox on that deletes writes
  that never reached the server.
- A cursor only means something against the log that issued it. Reset the log
  and every client holds a number from a log that no longer exists, usually
  pointing *past* the rebuilt one — so `seq > cursor` matches nothing and the
  client silently never syncs again.
- Pulling is not always safe. Applying a remote op can disturb work in
  progress; `canPull()` defers it. Pushing is always safe.
- The gate has to be the only door. `canWrite()` on the engine is useless if a
  caller can reach past it to the transport — so the transport isn't exported.

See the README for the long version.
