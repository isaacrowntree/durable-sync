# Changelog

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
