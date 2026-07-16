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
  maxSeq(): number;
  /** Drop every op and start a new epoch. Maintenance only — see handleReset. */
  clear(): number;
  /** Identifies this generation of the log; changes on clear(). */
  epoch(): string;
  readSnapshot(): Snapshot | null;
  writeSnapshot(snap: Snapshot): void;
}

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
}

export function handlePush(store: OpStore, ops: JournalOp[]): PushResult {
  let accepted = 0;
  const stored: string[] = [];
  for (const op of ops ?? []) {
    if (!op || typeof op.opId !== "string" || op.opId === "") continue;
    if (typeof op.kind !== "string" || op.kind === "") continue;
    if (store.insert({ opId: op.opId, kind: op.kind, payload: op.payload }) !== null) {
      accepted++;
    }
    // Inserted now, or already there from a push whose reply got lost. Either
    // way the log has it, so the client may drop it.
    stored.push(op.opId);
  }
  return { seq: store.maxSeq(), accepted, stored };
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
}

/** `withSnapshot` is opt-in, and only a cold-start caller (`since` 0) can use
 * one — a client mid-log already has the head. */
export function handlePull(store: OpStore, since: number, withSnapshot = false): PullResult {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const epoch = store.epoch();

  if (from === 0 && withSnapshot) {
    const snap = store.readSnapshot();
    // The log is never pruned, so this is only ever an accelerator: refusing
    // the snapshot and replaying from 0 always remains correct.
    if (snap) {
      return { snapshot: snap, ops: store.since(snap.seq), seq: store.maxSeq(), epoch };
    }
  }

  return { ops: store.since(from), seq: store.maxSeq(), epoch };
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
  private snap: Snapshot | null = null;

  epoch(): string {
    return this.gen;
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
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
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
    // A fold of the log we just threw away would hand every new device the
    // state this reset existed to destroy.
    this.sql.exec(`DELETE FROM snapshot`);
    this.sql.exec(`UPDATE meta SET v = ? WHERE k = 'epoch'`, crypto.randomUUID());
    return n;
  }
}
