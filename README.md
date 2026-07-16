# durable-sync

**Offline-first sync for Cloudflare Durable Objects.** An append-only op log on
the server, an outbox on the client. No Postgres, no container, no WebSocket.

```
npm i durable-sync
```

Cloudflare's own experimental `partysync` says of offline support:
*"maybe won't do."* This does. That's the whole pitch.

---

## Why this exists

If you want offline-first sync in 2026, the credible options — Zero, Electric,
PowerSync, InstantDB — all want **Postgres and a long-running container**. On
an all-Cloudflare stack that's a second backend, forever. Triplit was the one
engine with a Durable Object adapter, and it was
[acquired and abandoned](https://supabase.com/blog/triplit-joins-supabase)
(no commits since September 2025, docs site offline).

Meanwhile the platform already gives you the hard part for free: **a Durable
Object is a single-threaded ordering point, per user.** That's what everyone
else needs Postgres for.

So this is small on purpose:

- **Small on purpose.** It is a primitive, not a database.
- **No conflict resolution, deliberately.** Ops are immutable facts appended to
  a log. If two clients edit the same record and you need a merge, you want a
  CRDT — use Yjs or Automerge. If your writes are *events* ("this happened"),
  you don't have a conflict problem, and this is all you need.
- **HTTP, not WebSocket.** A socket is useless in a basement. Sync happens when
  the app is open and the network exists.
- **Zero dependencies.** Bring your own IndexedDB.

## What you get

| | |
|---|---|
| **Server** | append-only op log on DO SQLite; idempotent by `opId`; epochs |
| **Client** | durable outbox; per-device cursor; idempotent apply; replay-on-epoch-change |
| **Lifecycle** | sync on `visibilitychange` / `pageshow` / `focus` / `online` + poll, single-flighted and throttled |
| **Honesty** | a status you can show users that cannot claim success it didn't have |

## Server

```ts
// worker.ts
import { SyncJournal } from "durable-sync/server";
export class Journal extends SyncJournal {}
export default handler;
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "JOURNAL", "class_name": "Journal" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Journal"] }]
}
```

One instance per user is the whole design — `idFromName(userKey)` gives you
serialized writes and natural isolation, for free:

```ts
// app/api/sync/route.ts
export async function POST(req: Request) {
  const journal = journalFor(req);           // ns.get(ns.idFromName(userEmail))
  return journal.fetch("https://journal/push", {
    method: "POST",
    body: await req.text(),
    headers: { "content-type": "application/json" },
  });
}

export async function GET(req: Request) {
  const journal = journalFor(req);
  const since = new URL(req.url).searchParams.get("since") ?? "0";
  return journal.fetch(`https://journal/pull?since=${encodeURIComponent(since)}`);
}
```

Note what you did **not** route: `DELETE` (reset). The DO serves it, but it's
only reachable through the binding — export exactly what you want public.

## Client

```ts
import { createSync, localStorageCursor } from "durable-sync/client";

export const sync = createSync({
  endpoint: "/api/sync",
  outbox: dexieOutbox(db.outbox),                 // see below
  cursor: localStorageCursor("myapp.cursor"),
  stateKey: "myapp.syncState",

  // Idempotent: an op can arrive more than once.
  async apply(op) {
    if (op.kind !== "note" ) return false;
    const note = op.payload as Note;
    if (await db.notes.get(note.id)) return false;   // already have it
    await db.notes.put(note);
    return true;
  },

  // Pushing is always safe. Pulling might not be — see below.
  canPull: async () => !(await somethingInProgress()),
});

// Wire the lifecycle triggers. Call this from an effect, not at module scope —
// it returns a stop function, and there's nothing to listen to during SSR.
useEffect(() => sync.start(), []);
```

Writing is local-first: commit to IndexedDB, queue the op, let the network
catch up.

```ts
await db.notes.put(note);
await sync.enqueue({ opId: note.id, kind: "note", payload: note });
void sync.now({ force: true });   // best-effort; never await this on a user path
```

`force` skips the throttle — a write that just happened shouldn't wait out a
foregrounding window. It does **not** skip `canWrite`.

### The outbox must be durable

Until a push is acknowledged, **the outbox may hold the only copy of a write**.
Put it in IndexedDB — memory doesn't survive iOS killing a backgrounded PWA.
With Dexie (`outbox: "++id, opId"`), that's:

```ts
const dexieOutbox = (table) => ({
  add: (op) => table.add(op),
  list: () => table.toArray(),
  remove: (ids) => table.bulkDelete(ids),
  has: async (opId) => (await table.where({ opId }).count()) > 0,
});
```

### Showing sync state

`getState()` / `subscribe()` are shaped for React's `useSyncExternalStore`; the
snapshot is referentially stable between changes.

```tsx
const state = useSyncExternalStore(sync.subscribe, sync.getState, sync.getServerState);
// { lastOkAt?: number, lastError?: string }
```

Use `sync.getServerState` — an inline `() => ({})` returns a fresh object every
call and React throws *"The result of getServerSnapshot should be cached to
avoid an infinite loop."*

Ship this. Every failure path here is a silent catch — offline, a 500, an
expired session — because none of them should interrupt the user. The cost is
that "synced" and "silently broken for a week" look identical. This row is the
only thing that tells them apart.

## The four things this gets right that are easy to get wrong

These are the reason the package exists. Each one is a bug that shipped, in
production, in the app this was extracted from.

**1. `res.ok` is not evidence.** Behind an auth proxy (Cloudflare Access and
friends), an expired session redirects to a *same-origin* login page — which
`fetch` follows and reports as **200**. Drain the outbox on `res.ok` and you
delete writes that never reached the server. This validates the reply's shape
before touching the queue.

**2. A cursor only means something against the log that issued it.** Reset the
log and every client holds a number from a log that no longer exists — usually
pointing *past* the rebuilt one, so `seq > cursor` matches nothing and the
client **silently never syncs again**. Every pull carries an `epoch`; a client
that sees a new one replays from 0. `apply` is idempotent, so replay is cheap.

**3. Pulling is not always safe.** If applying a remote op can disturb work in
progress, `canPull()` defers it. In the app this was extracted from, a pull
mid-workout rewrote the working weight that the finish logic reads back — and
silently dropped a 5×5 to 3×5. Pushing is always safe; pulling isn't.

**4. The gate has to be the only door.** `canWrite()` exists because the journal
is addressed by a *server-side* identity while the ops carry whatever the client
selected — so writing as the wrong one files data under someone else,
permanently, in an append-only log. The same app had that gate on the engine and
a caller that reached past it straight to the transport: valid ack, outbox
drained, only copy gone. That's why the transport isn't exported here. There is
one way in.

## What this does not do

Being clear so you don't adopt it and find out:

- **No conflict resolution.** Last writer wins per record, and `apply` is yours.
- **No pagination.** `pull` returns everything after the cursor in one response.
  Fine for thousands of ops; not for millions.
- **No live push.** No WebSocket, so the other device converges on its next
  foreground — not instantly. That's the trade for working in a basement.
- **No auth.** Put it behind whatever you already use. The DO is addressed by
  whatever key you choose; that key is your isolation boundary.
- **One instance per identity.** `createSync` is single-tenant: the in-flight
  guard and the throttle live in the closure. If your app has several identities
  on one device, create one instance per identity and memoize it — a fresh
  instance per render resets the throttle that exists to collapse the
  foregrounding burst.
- **Nothing runs while the app is closed.** Safari has no Background Sync, and
  pretending otherwise would be a lie.

If you need any of those, you want a real sync engine —
[Zero](https://zero.rocicorp.dev/), [Electric](https://electric-sql.com/),
[PowerSync](https://www.powersync.com/) — and the Postgres that comes with it.

## Prior art

- **[partysync](https://github.com/cloudflare/partykit/tree/main/packages/partysync)**
  — Cloudflare's own; whole-state over WebSocket, explicitly punts on offline.
- **[Triplit](https://github.com/aspen-cloud/triplit)** — had a DO adapter;
  abandoned 2025. Worth reading.
- **[Yjs](https://yjs.dev/) / [Automerge](https://automerge.org/)** — real CRDTs.
  Use these if you genuinely need merge.

## License

MIT
