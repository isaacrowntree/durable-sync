/** The client half: an outbox that survives being offline, a cursor that knows
 * which log it belongs to, and the two requests between them. */

import type { StoredOp } from "../server/journal.js";

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
      const reply = (await res.json().catch(() => null)) as { seq?: unknown } | null;
      if (!isJournalReply(reply)) return { ok: false, pushed: 0 };
      await outbox.remove(rows.map((r) => r.id));
      return { ok: true, pushed: rows.length };
    } catch {
      // offline — the outbox flushes next time
      return { ok: false, pushed: 0 };
    }
  }

  async function fetchPull(from: number) {
    const res = await fetch(`${endpoint}?since=${from}`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { ops?: StoredOp[]; seq?: number; epoch?: string }
      | null;
    return isJournalReply(body) ? body : null;
  }

  /** Pull ops after our cursor and apply them. */
  async function pull(): Promise<PullOutcome> {
    const current = await cursor.read();
    const since = current.seq || 0;
    try {
      let body = await fetchPull(since);
      if (!body) return { ok: false, applied: 0 };

      // A cursor only means something against the generation that issued it.
      // If the log was rebuilt, ours points into a log that no longer exists —
      // usually PAST the new one, so `seq > cursor` matches nothing and we'd
      // silently never sync again. Replay from the start; apply is idempotent,
      // so it's cheap and safe. A client with no stored epoch replays once,
      // which is what lets already-deployed clients recover.
      const epoch = body.epoch;
      if (epoch && epoch !== current.epoch) {
        body = await fetchPull(0);
        if (!body) return { ok: false, applied: 0 };
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

  return { push, pull, enqueue };
}
