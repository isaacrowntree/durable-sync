# durable-sync

**Offline-first sync for Cloudflare Durable Objects.** An append-only op log on
the server, an outbox on the client. No Postgres, no container, no WebSocket.

```
npm i durable-sync
```

**[Docs and a live demo →](https://isaacrowntree.com/durable-sync/)** ·
[vs Zero, Electric, PowerSync](https://isaacrowntree.com/durable-sync/vs.html)

Cloudflare's own experimental `partysync` files offline support under a README
heading called *"Maybe won't do."* This does it. That's the whole pitch.

---

## Why this exists

If you want offline-first sync in 2026, the credible options — Electric,
PowerSync, InstantDB — all want **Postgres and a long-running container**. On
an all-Cloudflare stack that's a second backend, forever. (Zero wants both too,
and [doesn't do offline writes](https://zero.rocicorp.dev/docs/offline) at all —
"Zero is not local-first," in its own words.) Triplit was the one engine with a
Durable Object adapter; its co-founder
[joined Supabase](https://supabase.com/blog/triplit-joins-supabase) in October
2025 and it has sat unmaintained since — no commits since September 2025, docs
site offline.

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
| **Cold start** | optional snapshots, so a new device doesn't replay a log years long |
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
  const q = new URL(req.url).searchParams;
  const since = q.get("since") ?? "0";
  // Forward `snapshot` too, or the client asks for a fold and never gets one —
  // which costs a slow cold start, not a wrong one.
  const snap = q.get("snapshot") === "1" ? "&snapshot=1" : "";
  return journal.fetch(`https://journal/pull?since=${encodeURIComponent(since)}${snap}`);
}

// Only if you're using snapshots.
export async function PUT(req: Request) {
  const journal = journalFor(req);
  return journal.fetch("https://journal/snapshot", {
    method: "PUT",
    body: await req.text(),
    headers: { "content-type": "application/json" },
  });
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

### Snapshots, once the log is long

Skip this until you need it. A pull replays every op after your cursor, which
is nothing at all for a year and a real wait after a few: a lifter three years
in has tens of thousands of ops, and without a snapshot every new phone
downloads all of them and runs `apply` on each before showing a single number.
So does every client after a reset, since the recovery path is a replay from 0.

The journal can't fold the log for you — it never reads a payload, which is the
whole reason it stays a primitive. So a client folds, and the journal stores the
result as opaquely as it stores a payload:

```ts
export const sync = createSync({
  // ...as above
  snapshot: {
    capture: () => db.notes.toArray().then((notes) => ({ v: 1, notes })),
    async restore(blob) {
      // Refuse anything you don't recognise — a snapshot written by a build
      // that isn't this one. Returning false replays the whole log, which is
      // slow and always correct. Guessing is neither.
      if ((blob as any)?.v !== 1) return false;
      await db.notes.bulkPut((blob as any).notes);
      return true;
    },
  },
});
```

Nothing captures for you — only your app knows when its state is settled rather
than mid-edit:

```ts
// after a sync, when the log has grown enough to be worth folding
void sync.capture();
```

The log is never pruned, so a snapshot is only ever an accelerator: it can be
refused, corrupt, or absent and the log alone still rebuilds the client. Route
`PUT` to use it (see below). The journal refuses a fold of a generation that no
longer exists, so a reset can't be undone by a client that missed it.

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
[Zero](https://zero.rocicorp.dev/), [Electric](https://electric.ax/),
[PowerSync](https://www.powersync.com/) — and the Postgres that comes with it.

## Who uses it

[Rampset](https://github.com/isaacrowntree/rampset) — an offline-first barbell
training log on Cloudflare Workers, Access and R2. It's where this was
extracted from, and it's what the four warnings above are scar tissue from: a
real workout was destroyed by the `res.ok` one, in production, before it was
understood.

Rampset keeps what a sync library can't have — what its ops *mean*, and what
applying one does to its database — and this package owns the transport.

## Prior art

- **[partysync](https://github.com/cloudflare/partykit/tree/main/packages/partysync)**
  — Cloudflare's own, and the closest thing to this: delta sync over a WebSocket
  with an IndexedDB read cache, so it survives a refresh offline. What it has no
  answer for is a write made while disconnected. Read it before you read this.
- **[Triplit](https://github.com/aspen-cloud/triplit)** — had a DO adapter;
  unmaintained since Sept 2025. Worth reading.
- **[Yjs](https://yjs.dev/) / [Automerge](https://automerge.org/)** — real CRDTs.
  Use these if you genuinely need merge.

## License

MIT
