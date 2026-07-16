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
