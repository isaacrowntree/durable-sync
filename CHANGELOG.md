# Changelog

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
