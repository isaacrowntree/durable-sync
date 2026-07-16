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

export interface OpStore {
  /** The assigned seq, or null when opId already exists. */
  insert(op: JournalOp): number | null;
  since(seq: number): StoredOp[];
  maxSeq(): number;
  /** Drop every op and start a new epoch. Maintenance only — see handleReset. */
  clear(): number;
  /** Identifies this generation of the log; changes on clear(). */
  epoch(): string;
}

export interface PushResult {
  seq: number;
  accepted: number;
}

export function handlePush(store: OpStore, ops: JournalOp[]): PushResult {
  let accepted = 0;
  for (const op of ops ?? []) {
    if (!op || typeof op.opId !== "string" || op.opId === "") continue;
    if (typeof op.kind !== "string" || op.kind === "") continue;
    if (store.insert({ opId: op.opId, kind: op.kind, payload: op.payload }) !== null) {
      accepted++;
    }
  }
  return { seq: store.maxSeq(), accepted };
}

export interface PullResult {
  ops: StoredOp[];
  seq: number;
  /** Which generation of the log this cursor belongs to. A client that sees a
   * new epoch must replay from 0 — see the client's `pull`. */
  epoch: string;
}

export function handlePull(store: OpStore, since: number): PullResult {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  return { ops: store.since(from), seq: store.maxSeq(), epoch: store.epoch() };
}

/** Ops of one kind, whole. The log can't interpret payloads, so a caller that
 * needs to (e.g. to find which records a `delete` op removed) reads them here
 * and does its own interpretation. */
export function handleOpsByKind(store: OpStore, kind: string): { ops: StoredOp[] } {
  return { ops: store.since(0).filter((o) => o.kind === kind) };
}

/** Empty the log and start a new epoch.
 *
 * An append-only log has no delete, so an op that should never have been
 * recorded can't be withdrawn — reset is the escape hatch. It is only safe
 * when the ops still matter to someone are recoverable elsewhere; clients
 * bootstrap from that and the log rebuilds from the next write.
 *
 * The new epoch is what makes this safe: every client is holding a cursor from
 * a log that no longer exists, usually pointing PAST the rebuilt one, so
 * `seq > cursor` would match nothing and they'd silently never sync again. */
export function handleReset(store: OpStore): { cleared: number; epoch: string } {
  const cleared = store.clear();
  return { cleared, epoch: store.epoch() };
}

/** In-memory store — for tests, and the reference implementation of OpStore. */
export class MemoryOpStore implements OpStore {
  private ops: StoredOp[] = [];
  private ids = new Set<string>();
  private gen = crypto.randomUUID();

  epoch(): string {
    return this.gen;
  }

  insert(op: JournalOp): number | null {
    if (this.ids.has(op.opId)) return null;
    const seq = this.ops.length + 1;
    this.ops.push({ ...op, seq });
    this.ids.add(op.opId);
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
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // Stamp a generation on first use, so a log that predates this column
    // still reports one consistently from now on.
    sql.exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('epoch', ?)`, crypto.randomUUID());
  }

  epoch(): string {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = 'epoch'`).toArray();
    return String(rows[0]?.v ?? "");
  }

  insert(op: JournalOp): number | null {
    const dup = this.sql.exec(`SELECT seq FROM ops WHERE op_id = ?`, op.opId).toArray();
    if (dup.length > 0) return null;
    this.sql.exec(
      `INSERT INTO ops (op_id, kind, payload, ts) VALUES (?, ?, ?, ?)`,
      op.opId,
      op.kind,
      JSON.stringify(op.payload ?? null),
      Date.now(),
    );
    return this.maxSeq();
  }

  since(seq: number): StoredOp[] {
    return this.sql
      .exec(`SELECT seq, op_id, kind, payload FROM ops WHERE seq > ? ORDER BY seq`, seq)
      .toArray()
      .map((r) => ({
        seq: Number(r.seq),
        opId: String(r.op_id),
        kind: String(r.kind),
        payload: JSON.parse(String(r.payload)),
      }));
  }

  maxSeq(): number {
    const rows = this.sql.exec(`SELECT MAX(seq) AS m FROM ops`).toArray();
    return Number(rows[0]?.m ?? 0) || 0;
  }

  clear(): number {
    const n = this.maxSeq();
    this.sql.exec(`DELETE FROM ops`);
    this.sql.exec(`DELETE FROM sqlite_sequence WHERE name = 'ops'`);
    this.sql.exec(`UPDATE meta SET v = ? WHERE k = 'epoch'`, crypto.randomUUID());
    return n;
  }
}
