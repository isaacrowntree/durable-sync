/** SqlOpStore against real SQLite.
 *
 * The rest of the suite runs on MemoryOpStore, which is the reference
 * implementation but not the one that ships: every production journal is
 * SqlOpStore inside a Durable Object. A broken CHECK constraint or a typo in
 * an upsert is invisible to a test that never executes SQL, and shows up as a
 * runtime failure in the one place it can't be caught.
 *
 * `node:sqlite` is a builtin, so this costs no dependency. It isn't the DO's
 * SQLite, but it is SQLite, which is enough to catch statements that don't
 * parse or constraints that don't hold.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SqlOpStore,
  handlePush,
  handlePull,
  handleReset,
  handleSnapshot,
  DEFAULT_LIMITS,
  type SqlLike,
  type JournalOp,
} from "./journal.js";

/** The slice of the DO's SQLite API, over node:sqlite. */
function sqlite(): SqlLike {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const op = (opId: string, n = 1): JournalOp => ({ opId, kind: "set.logged", payload: { n } });

describe("SqlOpStore", () => {
  let sql: SqlLike;
  let store: SqlOpStore;

  beforeEach(() => {
    sql = sqlite();
    store = new SqlOpStore(sql);
  });

  it("assigns seqs and returns ops after a cursor", () => {
    handlePush(store, [op("a"), op("b"), op("c")]);
    expect(store.maxSeq()).toBe(3);
    expect(store.since(1).map((o) => o.opId)).toEqual(["b", "c"]);
  });

  it("round-trips a payload through JSON", () => {
    handlePush(store, [{ opId: "a", kind: "set.logged", payload: { weight: 102.5, reps: [5, 5] } }]);
    expect(store.since(0)[0]!.payload).toEqual({ weight: 102.5, reps: [5, 5] });
  });

  it("refuses a duplicate opId, so a retried push is free", () => {
    handlePush(store, [op("a")]);
    const again = handlePush(store, [op("a"), op("b")]);
    expect(again.accepted).toBe(1);
    expect(again.stored).toEqual(["a", "b"]); // the dup is still the log's
    expect(store.maxSeq()).toBe(2);
  });

  it("is created empty and reports a stable epoch", () => {
    const e = store.epoch();
    expect(e).toBeTruthy();
    handlePush(store, [op("a")]);
    expect(store.epoch()).toBe(e);
  });

  describe("snapshot", () => {
    beforeEach(() => handlePush(store, [op("a"), op("b"), op("c"), op("d")]));

    it("has none until one is written", () => {
      expect(store.readSnapshot()).toBeNull();
    });

    it("round-trips a blob", () => {
      handleSnapshot(store, { seq: 2, epoch: store.epoch(), blob: { pr: 100 } });
      expect(store.readSnapshot()).toEqual({ seq: 2, blob: { pr: 100 } });
    });

    /** The upsert path — a second fold must replace the first, not collide on
     * the primary key or accumulate rows. */
    it("replaces the previous fold rather than adding a row", () => {
      const e = store.epoch();
      handleSnapshot(store, { seq: 2, epoch: e, blob: { pr: 100 } });
      handleSnapshot(store, { seq: 4, epoch: e, blob: { pr: 140 } });

      expect(store.readSnapshot()).toEqual({ seq: 4, blob: { pr: 140 } });
      expect(sql.exec(`SELECT COUNT(*) AS c FROM snapshot`).toArray()[0]!.c).toBe(1);
    });

    it("serves the tail after the fold, not the whole log", () => {
      handleSnapshot(store, { seq: 3, epoch: store.epoch(), blob: {} });
      const r = handlePull(store, 0, true);
      expect(r.snapshot!.seq).toBe(3);
      expect(r.ops.map((o) => o.opId)).toEqual(["d"]);
    });

    it("survives the store being rebuilt, as it is on every DO restart", () => {
      handleSnapshot(store, { seq: 2, epoch: store.epoch(), blob: { pr: 100 } });
      expect(new SqlOpStore(sql).readSnapshot()).toEqual({ seq: 2, blob: { pr: 100 } });
    });

    it("is dropped by a reset, which also starts a new epoch", () => {
      const e = store.epoch();
      handleSnapshot(store, { seq: 2, epoch: e, blob: {} });

      expect(handleReset(store).cleared).toBe(4);
      expect(store.readSnapshot()).toBeNull();
      expect(store.maxSeq()).toBe(0);
      expect(store.epoch()).not.toBe(e);
    });

    /** The one that matters: a client that folded the old log and missed the
     * reset would otherwise hand every new device the state the reset existed
     * to destroy. */
    it("refuses a fold from a log generation that no longer exists", () => {
      const stale = store.epoch();
      handleReset(store);
      handlePush(store, [op("fresh")]);

      expect(handleSnapshot(store, { seq: 1, epoch: stale, blob: { ghost: true } }).ok).toBe(false);
      expect(store.readSnapshot()).toBeNull();
    });
  });
});

describe("SqlOpStore limits and pages", () => {
  it("keeps a running size that matches the log, and zeroes it on reset", () => {
    const sql = sqlite();
    const store = new SqlOpStore(sql);
    handlePush(store, [op("a"), op("😀")]);
    // set.logged = 10 bytes, {"n":1} = 7, ids 1 and 4.
    expect(store.bytes()).toBe(10 + 7 + 1 + 10 + 7 + 4);
    handleReset(store);
    expect(store.bytes()).toBe(0);
  });

  /** A journal from before the size was tracked has no `bytes` row: the first
   * construction after the upgrade measures what's already there. */
  it("measures a log that predates the running size", () => {
    const sql = sqlite();
    handlePush(new SqlOpStore(sql), [op("a"), op("b")]);
    sql.exec(`DELETE FROM meta WHERE k = 'bytes'`);
    expect(new SqlOpStore(sql).bytes()).toBe(2 * (10 + 7 + 1));
  });

  it("refuses past maxJournalBytes", () => {
    const store = new SqlOpStore(sqlite());
    const r = handlePush(store, [op("a"), op("b")], { ...DEFAULT_LIMITS, maxJournalBytes: 20 });
    expect(r).toMatchObject({ stored: ["a"], full: true });
  });

  it("pages by count and by bytes, reading only what it returns", () => {
    const store = new SqlOpStore(sqlite());
    handlePush(store, ["a", "b", "c", "d", "e"].map((id) => op(id)));
    expect(store.page(0, 2, 1_000_000)).toMatchObject({ more: true, ops: [{ opId: "a" }, { opId: "b" }] });
    expect(store.page(0, 10, 15).ops.map((o) => o.opId)).toEqual(["a", "b"]);
    expect(store.page(0, 10, 1).ops).toHaveLength(1);
    expect(store.page(3, 10, 1_000_000)).toMatchObject({ more: false, ops: [{ opId: "d" }, { opId: "e" }] });
    expect(store.page(5, 10, 1_000_000)).toEqual({ ops: [], more: false });
    const r = handlePull(store, 0, false, { ...DEFAULT_LIMITS, maxPullOps: 2 });
    expect(r).toMatchObject({ seq: 2, more: true });
  });

  it("reads one kind through the index", () => {
    const sql = sqlite();
    const store = new SqlOpStore(sql);
    handlePush(store, [op("a"), { opId: "b", kind: "other", payload: 1 }]);
    expect(store.byKind("other").map((o) => o.opId)).toEqual(["b"]);
    const plan = sql.exec(`EXPLAIN QUERY PLAN SELECT * FROM ops WHERE kind = ?`, "other").toArray();
    expect(JSON.stringify(plan)).toContain("ops_kind");
  });
});
