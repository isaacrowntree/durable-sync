/** A per-user, append-only op log.
 *
 * The Durable Object is the single-threaded consistency point that orders one
 * user's ops; this module is the pure logic, so it's testable without a
 * Workers runtime.
 *
 * Ops are opaque: `{ opId, kind, payload }`. The log never interprets a
 * payload, which is what keeps it a primitive rather than a database. */

export interface JournalOp {
  /** Idempotency key. Re-pushing the same opId is a no-op, so a client may
   * retry a push it isn't sure landed — the common case on a bad connection. */
  opId: string;
  kind: string;
  payload: unknown;
}

export interface StoredOp extends JournalOp {
  /** Server-assigned order. Monotonic within an epoch. */
  seq: number;
}

/** A client's fold of the log, so the next cold start doesn't have to repeat it.
 *
 * The log can't build this. It never interprets a payload — that's what keeps
 * it a primitive — so it cannot know what a hundred ops add up to. Only a
 * client with an `apply` knows that, so a client captures the fold and the
 * journal stores the result opaquely, exactly like a payload. */
export interface Snapshot {
  /** The state after applying every op up to and including this seq. */
  seq: number;
  /** Opaque. Whatever your `capture()` returned, handed back untouched. */
  blob: unknown;
}

export interface OpStore {
  /** The assigned seq, or null when opId already exists. */
  insert(op: JournalOp): number | null;
  since(seq: number): StoredOp[];
  /** Ops after `seq`, at most `maxOps` of them and — past the first —
   * at most `maxBytes` of payload. `more` says the log goes on. Optional:
   * without it a pull returns everything after `seq`. */
  page?(seq: number, maxOps: number, maxBytes: number): { ops: StoredOp[]; more: boolean };
  /** Ops of one kind. Optional: without it, `since(0)` is filtered. */
  byKind?(kind: string): StoredOp[];
  /** Whether the log holds this opId. Optional, with `bytes`. */
  has?(opId: string): boolean;
  /** What the log holds, in bytes (opId + kind + JSON payload, UTF-8).
   * Optional: without it, `maxJournalBytes` isn't enforced. */
  bytes?(): number;
  maxSeq(): number;
  /** Drop every op and start a new epoch. Maintenance only — see handleErase. */
  clear(): number;
  /** Identifies this generation of the log; changes on clear(). */
  epoch(): string;
  readSnapshot(): Snapshot | null;
  writeSnapshot(snap: Snapshot): void;
}

/** What one journal will take. Anyone who can sign up can push, so every
 * dimension a client controls is bounded. Override `limits` on your
 * SyncJournal subclass to change them. */
export interface JournalLimits {
  maxOpIdLength: number;
  maxKindLength: number;
  /** One op's payload, as UTF-8 JSON. Durable Object SQLite rows top out at
   * 2 MB, so an op much bigger than this would fail at the insert anyway. */
  maxOpBytes: number;
  /** Ops considered per push. The rest stay in the client's outbox for the
   * next one. A push of more than PUSH_REFUSE_FACTOR times this is refused
   * unread — see `PushResult.tooMany`. */
  maxPushOps: number;
  /** The whole log. Past it, pushes are refused with `full` and the client's
   * outbox keeps them. */
  maxJournalBytes: number;
  /** One pull page. A cold start on a long log takes several. */
  maxPullOps: number;
  maxPullBytes: number;
}

export const DEFAULT_LIMITS: JournalLimits = Object.freeze({
  maxOpIdLength: 256,
  maxKindLength: 128,
  maxOpBytes: 256 * 1024,
  maxPushOps: 1000,
  maxJournalBytes: 256 * 1024 * 1024,
  maxPullOps: 5000,
  maxPullBytes: 4 * 1024 * 1024,
});

/** A push this many times past `maxPushOps` isn't a backlog to take a slice
 * of — it's refused before any op is looked at. The slack is for clients that
 * predate `tooMany` and send their whole outbox: a modest backlog still goes
 * through a slice at a time. */
export const PUSH_REFUSE_FACTOR = 4;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).byteLength;

export interface PushResult {
  seq: number;
  /** How many ops this push added to the log. Duplicates aren't counted. */
  accepted: number;
  /** The opIds the log now holds — inserted just now, or already present from
   * an earlier push. This is the client's permission to forget its copy, and
   * it is deliberately not the same as the opIds it sent: an op refused here
   * is absent from this list, so the client keeps it.
   *
   * A count can't carry that. `accepted` is 1 both when one of two ops was
   * stored and the other refused, and when one was stored and the other was a
   * duplicate — and those need opposite handling. */
  stored: string[];
  /** opIds this journal will never take as sent — too big, an overlong id or
   * kind, a payload that won't serialise. Resending can't help, so the client
   * hands them to `onRejected` and takes them out of its outbox. An op with no
   * usable opId at all can't be named, and is just skipped. */
  rejected: string[];
  /** The log is at `maxJournalBytes`. Nothing from the first op that didn't
   * fit onwards was stored — order is kept — and the client keeps it all. */
  full?: true;
  /** The push was refused unread: it carried far more ops than this journal
   * considers in one push. This is the most to send per push. Nothing was
   * stored, and `stored` is empty, so every client — including one that
   * predates this field — keeps its whole outbox. */
  tooMany?: number;
}

export function handlePush(store: OpStore, ops: JournalOp[], limits: JournalLimits = DEFAULT_LIMITS): PushResult {
  // The route has already parsed this and RPC has copied it, so the memory is
  // spent; what's saved is the per-op work, and the client learns to send less.
  if (Array.isArray(ops) && ops.length > limits.maxPushOps * PUSH_REFUSE_FACTOR) {
    return { seq: store.maxSeq(), accepted: 0, stored: [], rejected: [], tooMany: limits.maxPushOps };
  }
  let accepted = 0;
  const stored: string[] = [];
  const rejected: string[] = [];
  let full = false;
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, limits.maxPushOps)) {
    if (!op || typeof op.opId !== "string" || op.opId === "") continue;
    const { opId, kind } = op;
    if (opId.length > limits.maxOpIdLength || typeof kind !== "string" || kind === "" || kind.length > limits.maxKindLength) {
      rejected.push(opId);
      continue;
    }
    let json: string;
    try {
      json = JSON.stringify(op.payload ?? null);
    } catch {
      rejected.push(opId);
      continue;
    }
    const size = byteLength(json);
    if (size > limits.maxOpBytes) {
      rejected.push(opId);
      continue;
    }
    if (store.bytes && store.bytes() + size + byteLength(opId) + byteLength(kind) > limits.maxJournalBytes) {
      // Already held from a push whose reply got lost: still the client's to drop.
      if (store.has?.(opId)) {
        stored.push(opId);
        continue;
      }
      full = true;
      break;
    }
    if (store.insert({ opId, kind, payload: op.payload }) !== null) {
      accepted++;
    }
    // Inserted now, or already there from a push whose reply got lost. Either
    // way the log has it, so the client may drop it.
    stored.push(opId);
  }
  return { seq: store.maxSeq(), accepted, stored, rejected, ...(full ? { full: true as const } : {}) };
}

export interface PullResult {
  ops: StoredOp[];
  seq: number;
  /** Which generation of the log this cursor belongs to. A client that sees a
   * new epoch must replay from 0 — see the client's `pull`. */
  epoch: string;
  /** Only ever present when the caller asked for one, because `ops` is then a
   * tail rather than the whole log — a client that got one it can't restore
   * holds an incomplete history and must refetch without asking. */
  snapshot?: Snapshot;
  /** There are ops past this page: pull again from `seq`. When it's set,
   * `seq` is the last op in `ops`, not the head of the log — so a client that
   * predates paging and just stores `seq` resumes from the right place and
   * catches up a page per sync, rather than skipping what it wasn't sent. */
  more?: true;
}

/** `withSnapshot` is opt-in, and only a cold-start caller (`since` 0) can use
 * one — a client mid-log already has the head. */
export function handlePull(
  store: OpStore,
  since: number,
  withSnapshot = false,
  limits: JournalLimits = DEFAULT_LIMITS,
): PullResult {
  const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  const epoch = store.epoch();

  const after = (seq: number): Omit<PullResult, "epoch" | "snapshot"> => {
    if (!store.page) return { ops: store.since(seq), seq: store.maxSeq() };
    const { ops, more } = store.page(seq, limits.maxPullOps, limits.maxPullBytes);
    return more ? { ops, seq: ops[ops.length - 1]!.seq, more: true } : { ops, seq: store.maxSeq() };
  };

  if (from === 0 && withSnapshot) {
    const snap = store.readSnapshot();
    // The log is never pruned, so this is only ever an accelerator: refusing
    // the snapshot and replaying from 0 always remains correct.
    if (snap) {
      return { snapshot: snap, ...after(snap.seq), epoch };
    }
  }

  return { ...after(from), epoch };
}

export interface SnapshotResult {
  ok: boolean;
  /** The seq of the snapshot the log now holds; 0 if it has none. */
  seq: number;
}

/** Store a client's fold, if it's coherent.
 *
 * A snapshot is a cache of a fold anyone with the same `apply` would compute,
 * so a client writing one isn't a new trust boundary. What it can be is a
 * *stale* one, and the two ways that goes wrong are both refused here: a fold
 * of a log generation that no longer exists (epoch mismatch — the reset it
 * missed would otherwise be undone for every new device), and a fold claiming
 * to cover ops this log has never seen. */
export function handleSnapshot(
  store: OpStore,
  snap: { seq?: unknown; epoch?: unknown; blob?: unknown },
): SnapshotResult {
  const current = store.readSnapshot();
  const held = current?.seq ?? 0;
  const refuse = { ok: false, seq: held };

  if (snap?.epoch !== store.epoch()) return refuse;

  const seq = snap.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) return refuse;
  if (seq > store.maxSeq()) return refuse;
  // An older fold than the one we hold is worthless — two clients racing, or
  // one that's been offline for a month. Not an error, just nothing to do.
  if (seq <= held) return { ok: false, seq: held };

  store.writeSnapshot({ seq, blob: snap.blob });
  return { ok: true, seq };
}

/** Ops of one kind, whole. The log can't interpret payloads, so a caller that
 * needs to (e.g. to find which records a `delete` op removed) reads them here
 * and does its own interpretation. */
export function handleOpsByKind(store: OpStore, kind: string): { ops: StoredOp[] } {
  if (store.byKind) return { ops: store.byKind(kind) };
  return { ops: store.since(0).filter((o) => o.kind === kind) };
}

/** What a log entry costs against `maxJournalBytes`. */
function entryBytes(op: { opId: string; kind: string }, payloadJson: string): number {
  return byteLength(op.opId) + byteLength(op.kind) + byteLength(payloadJson);
}

/** Empty the log and start a new epoch. Irreversible.
 *
 * An append-only log has no delete, so an op that should never have been
 * recorded can't be withdrawn — reset is the escape hatch. It is only safe
 * when the ops still matter to someone are recoverable elsewhere; clients
 * bootstrap from that and the log rebuilds from the next write.
 *
 * The new epoch is what makes this safe: every client is holding a cursor from
 * a log that no longer exists, usually pointing PAST the rebuilt one, so
 * `seq > cursor` would match nothing and they'd silently never sync again. */
export function handleErase(store: OpStore): { cleared: number; epoch: string } {
  const cleared = store.clear();
  return { cleared, epoch: store.epoch() };
}

/** In-memory store — for tests, and the reference implementation of OpStore. */
export class MemoryOpStore implements OpStore {
  private ops: StoredOp[] = [];
  private ids = new Set<string>();
  private gen = crypto.randomUUID();
  private snap: Snapshot | null = null;
  private size = 0;

  epoch(): string {
    return this.gen;
  }

  has(opId: string): boolean {
    return this.ids.has(opId);
  }

  bytes(): number {
    return this.size;
  }

  page(seq: number, maxOps: number, maxBytes: number): { ops: StoredOp[]; more: boolean } {
    const rest = this.since(seq);
    const ops: StoredOp[] = [];
    let bytes = 0;
    for (const op of rest) {
      const size = byteLength(JSON.stringify(op.payload ?? null));
      if (ops.length >= maxOps || (ops.length > 0 && bytes + size > maxBytes)) break;
      ops.push(op);
      bytes += size;
    }
    return { ops, more: ops.length < rest.length };
  }

  byKind(kind: string): StoredOp[] {
    return this.ops.filter((o) => o.kind === kind);
  }

  readSnapshot(): Snapshot | null {
    return this.snap;
  }

  writeSnapshot(snap: Snapshot): void {
    this.snap = snap;
  }

  insert(op: JournalOp): number | null {
    if (this.ids.has(op.opId)) return null;
    const seq = this.ops.length + 1;
    this.ops.push({ ...op, seq });
    this.ids.add(op.opId);
    this.size += entryBytes(op, JSON.stringify(op.payload ?? null));
    return seq;
  }

  since(seq: number): StoredOp[] {
    return this.ops.filter((o) => o.seq > seq);
  }

  maxSeq(): number {
    return this.ops.length;
  }

  clear(): number {
    const n = this.ops.length;
    this.ops = [];
    this.ids.clear();
    this.size = 0;
    // A fold of the log we just threw away would hand every new device the
    // state this reset existed to destroy.
    this.snap = null;
    this.gen = crypto.randomUUID();
    return n;
  }
}

/** The slice of the Durable Object SQLite API this needs. Declared rather than
 * imported so the package has no dependency on Workers types. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** SQLite-backed store, for use inside a Durable Object. The DO is
 * single-threaded, so check-then-insert has no race. */
export class SqlOpStore implements OpStore {
  constructor(private sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`,
    );
    // opsByKind reads one kind; without this it's a scan of the whole log.
    sql.exec(`CREATE INDEX IF NOT EXISTS ops_kind ON ops (kind)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // The log's size, kept as a running total so a push doesn't sum the log.
    // A log from before this was tracked is measured once, here.
    sql.exec(
      `INSERT OR IGNORE INTO meta (k, v) SELECT 'bytes', CAST(COALESCE(SUM(
        LENGTH(CAST(op_id AS BLOB)) + LENGTH(CAST(kind AS BLOB)) + LENGTH(CAST(payload AS BLOB))), 0) AS TEXT) FROM ops`,
    );
    // Stamp a generation on first use, so a log that predates this column
    // still reports one consistently from now on.
    sql.exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('epoch', ?)`, crypto.randomUUID());
    // At most one snapshot — an older fold is worthless once a newer one lands.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        seq INTEGER NOT NULL,
        blob TEXT NOT NULL
      )`,
    );
  }

  epoch(): string {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = 'epoch'`).toArray();
    return String(rows[0]?.v ?? "");
  }

  readSnapshot(): Snapshot | null {
    const rows = this.sql.exec(`SELECT seq, blob FROM snapshot WHERE id = 1`).toArray();
    const row = rows[0];
    if (!row) return null;
    return { seq: Number(row.seq), blob: JSON.parse(String(row.blob)) };
  }

  writeSnapshot(snap: Snapshot): void {
    this.sql.exec(
      `INSERT INTO snapshot (id, seq, blob) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, blob = excluded.blob`,
      snap.seq,
      JSON.stringify(snap.blob ?? null),
    );
  }

  insert(op: JournalOp): number | null {
    if (this.has(op.opId)) return null;
    const payload = JSON.stringify(op.payload ?? null);
    this.sql.exec(
      `INSERT INTO ops (op_id, kind, payload, ts) VALUES (?, ?, ?, ?)`,
      op.opId,
      op.kind,
      payload,
      Date.now(),
    );
    this.sql.exec(
      `UPDATE meta SET v = CAST(CAST(v AS INTEGER) + ? AS TEXT) WHERE k = 'bytes'`,
      entryBytes(op, payload),
    );
    return this.maxSeq();
  }

  has(opId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM ops WHERE op_id = ?`, opId).toArray().length > 0;
  }

  bytes(): number {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = 'bytes'`).toArray();
    return Number(rows[0]?.v ?? 0) || 0;
  }

  /** Sizes first, then only the rows that fit: a page never loads more
   * payload than it returns. */
  page(seq: number, maxOps: number, maxBytes: number): { ops: StoredOp[]; more: boolean } {
    const sizes = this.sql
      .exec(`SELECT seq, LENGTH(CAST(payload AS BLOB)) AS n FROM ops WHERE seq > ? ORDER BY seq LIMIT ?`, seq, maxOps + 1)
      .toArray();
    let last = seq;
    let taken = 0;
    let bytes = 0;
    for (const row of sizes) {
      const size = Number(row.n);
      if (taken >= maxOps || (taken > 0 && bytes + size > maxBytes)) break;
      last = Number(row.seq);
      taken++;
      bytes += size;
    }
    const ops = taken === 0 ? [] : this.read(`WHERE seq > ? AND seq <= ? ORDER BY seq`, seq, last);
    return { ops, more: taken < sizes.length };
  }

  byKind(kind: string): StoredOp[] {
    return this.read(`WHERE kind = ? ORDER BY seq`, kind);
  }

  private read(where: string, ...bindings: unknown[]): StoredOp[] {
    return this.sql
      .exec(`SELECT seq, op_id, kind, payload FROM ops ${where}`, ...bindings)
      .toArray()
      .map((r) => ({
        seq: Number(r.seq),
        opId: String(r.op_id),
        kind: String(r.kind),
        payload: JSON.parse(String(r.payload)),
      }));
  }

  since(seq: number): StoredOp[] {
    return this.read(`WHERE seq > ? ORDER BY seq`, seq);
  }

  maxSeq(): number {
    const rows = this.sql.exec(`SELECT MAX(seq) AS m FROM ops`).toArray();
    return Number(rows[0]?.m ?? 0) || 0;
  }

  clear(): number {
    const n = this.maxSeq();
    this.sql.exec(`DELETE FROM ops`);
    this.sql.exec(`DELETE FROM sqlite_sequence WHERE name = 'ops'`);
    this.sql.exec(`UPDATE meta SET v = '0' WHERE k = 'bytes'`);
    // A fold of the log we just threw away would hand every new device the
    // state this reset existed to destroy.
    this.sql.exec(`DELETE FROM snapshot`);
    this.sql.exec(`UPDATE meta SET v = ? WHERE k = 'epoch'`, crypto.randomUUID());
    return n;
  }
}
