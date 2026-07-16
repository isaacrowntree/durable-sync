/** The client half: an outbox that survives being offline, a cursor that knows
 * which log it belongs to, and the two requests between them. */

import type { StoredOp, Snapshot } from "../server/journal.js";

/** Skips the cold-start replay: fold the log once, and let the next device
 * start from the fold instead of repeating it.
 *
 * A log that runs for years is the point of this package and also its bill. A
 * lifter three years in has tens of thousands of ops, and without this every
 * new phone downloads all of them and runs `apply` on each one before showing
 * a single number — as does every client after a reset, since the recovery
 * path is to replay from 0.
 *
 * The blob is opaque to the journal, so its shape is yours and so is its
 * versioning: stamp it, and refuse a stamp you don't recognise. */
export interface SnapshotAdapter {
  /** Fold current local state into something JSON-serialisable. */
  capture(): Promise<unknown> | unknown;
  /** Rebuild local state from a blob `capture()` produced. Return false — or
   * throw — if you can't, and the client replays the whole log instead. That
   * fallback is what makes a snapshot from an older build survivable rather
   * than fatal, so prefer refusing to guessing. */
  restore(blob: unknown): Promise<boolean> | boolean;
}

export interface OutboxRow {
  /** Whatever your store uses as a row key — opaque here. */
  id: unknown;
  opId: string;
  kind: string;
  payload: unknown;
}

/** Where unsent ops wait. This must be DURABLE — surviving a reload, a crash,
 * and iOS killing a backgrounded PWA — because until a push is acknowledged
 * it may be the only copy of the write in existence. IndexedDB, not memory. */
export interface OutboxStore {
  add(op: { opId: string; kind: string; payload: unknown }): Promise<void>;
  list(): Promise<OutboxRow[]>;
  remove(ids: unknown[]): Promise<void>;
  has(opId: string): Promise<boolean>;
}

export interface Cursor {
  seq: number;
  /** The log generation this seq belongs to. Undefined = never synced. */
  epoch?: string;
}

export interface CursorStore {
  read(): Promise<Cursor> | Cursor;
  write(cursor: Cursor): Promise<void> | void;
}

export interface TransportOptions {
  /** Your route that forwards to the journal's DO. Default `/api/sync`. */
  endpoint?: string;
  outbox: OutboxStore;
  cursor: CursorStore;
  /** Apply one op locally. Return true if it changed anything.
   *
   * MUST be idempotent: an op can arrive more than once (a replay after an
   * epoch change, a retry, two tabs pulling at once). Throwing is survivable —
   * the op is stepped over rather than allowed to wedge the cursor — but
   * silently applying twice is not. */
  apply(op: StoredOp): Promise<boolean>;
  /** Extra headers per request — e.g. an auth header in local dev. */
  headers?(): HeadersInit;
  timeoutMs?: number;
  /** Omit and every cold start replays the whole log, which is the right
   * trade until the log is long. Nothing captures for you — see `capture()`. */
  snapshot?: SnapshotAdapter;
}

const DEFAULT_TIMEOUT = 10_000;

/** Did this response really come from the journal?
 *
 * Behind an auth proxy (Cloudflare Access, and others), an expired session
 * redirects to a same-origin login page — which fetch FOLLOWS, and reports as
 * a 200. `res.ok` is therefore not evidence of anything. The outbox may hold
 * the only copy of a write, so it may only be drained against a reply the
 * journal demonstrably wrote. */
function isJournalReply<T extends { seq?: unknown }>(
  body: T | null,
): body is T & { seq: number } {
  return typeof body?.seq === "number";
}

export interface PushOutcome {
  ok: boolean;
  pushed: number;
}
export interface PullOutcome {
  ok: boolean;
  applied: number;
}

export function createTransport(opts: TransportOptions) {
  const {
    endpoint = "/api/sync",
    outbox,
    cursor,
    apply,
    headers,
    timeoutMs = DEFAULT_TIMEOUT,
    snapshot,
  } = opts;

  const requestHeaders = (extra: HeadersInit = {}): HeadersInit => ({
    // Makes a well-behaved auth proxy answer an expired session with 401
    // rather than handing us its login page dressed as a 200. Belt and
    // braces: isJournalReply is what actually protects the outbox.
    "x-requested-with": "XMLHttpRequest",
    ...extra,
    ...headers?.(),
  });

  /** Send everything queued. Failure keeps the queue intact. */
  async function push(): Promise<PushOutcome> {
    const rows = await outbox.list();
    if (rows.length === 0) return { ok: true, pushed: 0 }; // nothing queued isn't a failure
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: requestHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          ops: rows.map((r) => ({ opId: r.opId, kind: r.kind, payload: r.payload })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, pushed: 0 };
      const reply = (await res.json().catch(() => null)) as
        | { seq?: unknown; stored?: unknown }
        | null;
      if (!isJournalReply(reply)) return { ok: false, pushed: 0 };

      // Drain only what the journal said it holds. A reply proves the journal
      // answered; it does not prove the journal took every op — it refuses one
      // with a blank opId or kind, and draining that on the strength of the
      // reply is the same bug as trusting `res.ok`, one layer in.
      //
      // A journal older than this client sends no `stored`. Nothing can be
      // inferred from that, so keep the pre-existing behaviour rather than
      // stall a rollout where the Worker lags the PWA.
      const stored = Array.isArray(reply.stored) ? new Set(reply.stored as unknown[]) : null;
      const drain = stored ? rows.filter((r) => stored.has(r.opId)) : rows;

      await outbox.remove(drain.map((r) => r.id));
      return { ok: true, pushed: drain.length };
    } catch {
      // offline — the outbox flushes next time
      return { ok: false, pushed: 0 };
    }
  }

  async function fetchPull(from: number, withSnapshot = false) {
    const q = withSnapshot ? `?since=${from}&snapshot=1` : `?since=${from}`;
    const res = await fetch(`${endpoint}${q}`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { ops?: StoredOp[]; seq?: number; epoch?: string; snapshot?: Snapshot }
      | null;
    return isJournalReply(body) ? body : null;
  }

  /** True only if local state now really is the snapshot. Anything else — no
   * adapter, a refusal, a throw — is false, and the caller replays the log. */
  async function restoreSnapshot(snap: Snapshot): Promise<boolean> {
    if (!snapshot) return false;
    try {
      return await snapshot.restore(snap.blob);
    } catch {
      // A blob this build can't read is exactly what the log is still for.
      return false;
    }
  }

  /** Fold the log so the next cold start doesn't have to.
   *
   * Nothing calls this for you: only the app knows when its state is worth
   * folding and when it's mid-edit. Cheap to skip, safe to repeat, and never
   * required — the log alone is always enough. */
  async function capture(): Promise<boolean> {
    if (!snapshot) return false;
    const { seq, epoch } = await cursor.read();
    // Nothing pulled yet, so there's nothing this could be a fold *of*. And
    // without the epoch the journal can't tell whether we're folding the log
    // it has or one it threw away.
    if (!seq || !epoch) return false;
    try {
      const blob = await snapshot.capture();
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: requestHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ seq, epoch, blob }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const reply = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      return reply?.ok === true;
    } catch {
      // Offline, or a fold that wouldn't serialise. Neither costs anything:
      // the log is untouched and the next attempt can try again.
      return false;
    }
  }

  /** Pull ops after our cursor and apply them. */
  async function pull(): Promise<PullOutcome> {
    const current = await cursor.read();
    const since = current.seq || 0;
    // Only a cold start can use a fold, and only if we know how to unfold it.
    const wantSnapshot = since === 0 && !!snapshot;
    try {
      let body = await fetchPull(since, wantSnapshot);
      if (!body) return { ok: false, applied: 0 };

      // A cursor only means something against the generation that issued it.
      // If the log was rebuilt, ours points into a log that no longer exists —
      // usually PAST the new one, so `seq > cursor` matches nothing and we'd
      // silently never sync again. Replay from the start; apply is idempotent,
      // so it's cheap and safe. A client with no stored epoch replays once,
      // which is what lets already-deployed clients recover.
      const epoch = body.epoch;
      if (epoch && epoch !== current.epoch) {
        // The replay a reset forces is the most expensive pull there is, so
        // it's the one that most wants a fold.
        body = await fetchPull(0, !!snapshot);
        if (!body) return { ok: false, applied: 0 };
      }

      // `ops` is a tail whenever a snapshot came back, so failing to restore
      // one means the history in hand has a hole at the front. Refetch the
      // whole log rather than apply a tail onto nothing.
      if (body.snapshot) {
        if (!(await restoreSnapshot(body.snapshot))) {
          body = await fetchPull(0, false);
          if (!body) return { ok: false, applied: 0 };
        }
      }

      let applied = 0;
      for (const op of body.ops ?? []) {
        try {
          if (await apply(op)) applied++;
        } catch {
          // One bad op must not strand every op behind it — and must not pin
          // the cursor here, or every later sync refetches it, throws again,
          // and never makes progress.
        }
      }
      // Keep the epoch we know when a reply omits one — writing `undefined`
      // would make the next reply that HAS one look like a new generation and
      // trigger a needless full replay.
      await cursor.write({ seq: body.seq, epoch: epoch ?? current.epoch });
      return { ok: true, applied };
    } catch {
      return { ok: false, applied: 0 };
    }
  }

  /** Queue an op. Local and durable — no network, so it's safe to await on the
   * write path, and it's what guarantees nothing is lost if the push never
   * gets a connection. */
  async function enqueue(op: { opId: string; kind: string; payload: unknown }): Promise<void> {
    if (await outbox.has(op.opId)) return;
    await outbox.add(op);
  }

  return { push, pull, enqueue, capture };
}
