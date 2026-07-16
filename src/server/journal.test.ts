import { describe, it, expect } from "vitest";
import {
  MemoryOpStore,
  handlePush,
  handlePull,
  handleReset,
  handleOpsByKind,
  handleSnapshot,
  type JournalOp,
} from "./journal.js";

const op = (opId: string, n = 1, kind = "put"): JournalOp => ({ opId, kind, payload: { n } });

describe("op log", () => {
  it("assigns increasing sequence numbers to pushed ops", () => {
    const store = new MemoryOpStore();
    const r = handlePush(store, [op("a"), op("b")]);
    expect(r.seq).toBe(2);
    expect(r.accepted).toBe(2);
  });

  // A client that loses the response can't know whether its push landed, so
  // retrying must be free. That's what makes the outbox safe to drain.
  it("ignores duplicate opIds, so a retry is harmless", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a")]);
    const again = handlePush(store, [op("a"), op("b")]);
    expect(again.accepted).toBe(1);
    expect(handlePull(store, 0).ops).toHaveLength(2);
  });

  it("pulls only ops after the cursor, and reports the new one", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a"), op("b"), op("c")]);
    const r = handlePull(store, 1);
    expect(r.ops.map((o) => o.opId)).toEqual(["b", "c"]);
    expect(r.seq).toBe(3);
  });

  it("pulling from the head returns nothing", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a")]);
    expect(handlePull(store, 1).ops).toEqual([]);
  });

  it("rejects malformed ops without poisoning the log", () => {
    const store = new MemoryOpStore();
    const r = handlePush(store, [
      { opId: "", kind: "put", payload: 1 },
      { opId: "ok", kind: "", payload: 1 },
      op("good"),
    ]);
    expect(r.accepted).toBe(1);
    expect(handlePull(store, 0).ops.map((o) => o.opId)).toEqual(["good"]);
  });

  /** `stored` is what the client drains against, so it has to name exactly the
   * ops the log holds — never the ones it refused. */
  it("names only the ops it kept, so a refused one can't be drained", () => {
    const store = new MemoryOpStore();
    const r = handlePush(store, [
      { opId: "", kind: "put", payload: 1 },
      { opId: "ok", kind: "", payload: 1 },
      op("good"),
    ]);
    expect(r.stored).toEqual(["good"]);
  });

  /** A duplicate is refused for insertion but the log still has it, so the
   * client must be told to forget it — otherwise a retried push queues forever. */
  it("names a duplicate as stored, even though it wasn't accepted", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a")]);
    const again = handlePush(store, [op("a"), op("b")]);
    expect(again.accepted).toBe(1);
    expect(again.stored).toEqual(["a", "b"]);
  });
});

/** A cursor is only meaningful against the log that issued it. Reset the log
 * and every client holds a number from a log that no longer exists — pointing
 * PAST the rebuilt one, so `seq > cursor` matches nothing and the new ops are
 * invisible forever. The epoch is how a client notices. */
describe("epoch", () => {
  it("is stable across pulls", () => {
    const store = new MemoryOpStore();
    const e = handlePull(store, 0).epoch;
    expect(e).toBeTruthy();
    handlePush(store, [op("a")]);
    expect(handlePull(store, 0).epoch).toBe(e);
  });

  it("changes on reset, so clients know to replay", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a"), op("b")]);
    const before = handlePull(store, 0).epoch;

    const r = handleReset(store);

    expect(r.cleared).toBe(2);
    expect(r.epoch).not.toBe(before);
    expect(handlePull(store, 0).epoch).not.toBe(before);
  });

  it("a reset log rebuilds cleanly, and a used opId is free again", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("old")]);
    handleReset(store);

    const after = handlePush(store, [op("old"), op("new")]);
    expect(after.accepted).toBe(2);
    expect(handlePull(store, 0).seq).toBe(2);
  });
});

/** The log can't fold itself — it never reads a payload — so a client folds
 * and hands back the result. The log stores it as opaquely as it stores a
 * payload, and it stays an accelerator: nothing is pruned, so refusing a
 * snapshot and replaying from 0 is always still correct. */
describe("snapshot", () => {
  const filled = () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a"), op("b"), op("c")]);
    return store;
  };

  it("is absent until a client folds the log", () => {
    const store = filled();
    expect(handlePull(store, 0, true).snapshot).toBeUndefined();
    expect(handlePull(store, 0, true).ops).toHaveLength(3);
  });

  it("comes back with only the ops after it", () => {
    const store = filled();
    const e = store.epoch();
    expect(handleSnapshot(store, { seq: 2, epoch: e, blob: { total: 2 } })).toEqual({
      ok: true,
      seq: 2,
    });

    const r = handlePull(store, 0, true);
    expect(r.snapshot).toEqual({ seq: 2, blob: { total: 2 } });
    expect(r.ops.map((o) => o.opId)).toEqual(["c"]); // the tail, not the log
    expect(r.seq).toBe(3);
  });

  /** Only a caller that asked can be sent a tail — anyone else would be handed
   * a history with a hole at the front and never know. */
  it("is withheld from a caller that didn't ask, who gets the whole log", () => {
    const store = filled();
    handleSnapshot(store, { seq: 2, epoch: store.epoch(), blob: {} });

    const r = handlePull(store, 0);
    expect(r.snapshot).toBeUndefined();
    expect(r.ops.map((o) => o.opId)).toEqual(["a", "b", "c"]);
  });

  it("is withheld mid-log, where it would skip ops the client lacks", () => {
    const store = filled();
    handleSnapshot(store, { seq: 2, epoch: store.epoch(), blob: {} });

    const r = handlePull(store, 1, true);
    expect(r.snapshot).toBeUndefined();
    expect(r.ops.map((o) => o.opId)).toEqual(["b", "c"]);
  });

  /** The dangerous one. A client that folded the old log and missed the reset
   * would otherwise hand every new device the state the reset destroyed. */
  it("refuses a fold of a log generation that no longer exists", () => {
    const store = filled();
    const stale = store.epoch();
    handleReset(store);
    handlePush(store, [op("fresh")]);

    expect(handleSnapshot(store, { seq: 1, epoch: stale, blob: { ghost: true } })).toEqual({
      ok: false,
      seq: 0,
    });
    expect(handlePull(store, 0, true).snapshot).toBeUndefined();
  });

  it("drops its snapshot on reset", () => {
    const store = filled();
    handleSnapshot(store, { seq: 3, epoch: store.epoch(), blob: {} });
    handleReset(store);
    expect(store.readSnapshot()).toBeNull();
  });

  it("refuses a fold of ops it has never seen", () => {
    const store = filled();
    expect(handleSnapshot(store, { seq: 99, epoch: store.epoch(), blob: {} }).ok).toBe(false);
  });

  it("refuses a seq that isn't a positive integer", () => {
    const store = filled();
    const e = store.epoch();
    for (const seq of [0, -1, 1.5, "2", null, undefined, NaN]) {
      expect(handleSnapshot(store, { seq, epoch: e, blob: {} }).ok).toBe(false);
    }
  });

  /** Two clients race, or one has been offline a month. Not an error — the
   * newer fold just wins, and the older one must not undo it. */
  it("keeps the newer fold when an older one arrives late", () => {
    const store = filled();
    const e = store.epoch();
    handleSnapshot(store, { seq: 3, epoch: e, blob: { v: "new" } });

    expect(handleSnapshot(store, { seq: 1, epoch: e, blob: { v: "old" } })).toEqual({
      ok: false,
      seq: 3,
    });
    expect(store.readSnapshot()).toEqual({ seq: 3, blob: { v: "new" } });
  });
});

/** The log can't interpret payloads — that's what keeps it generic — so a
 * caller that needs to (e.g. to find what a `delete` op removed) reads the
 * ops of that kind and interprets them itself. */
describe("ops by kind", () => {
  it("returns whole ops of one kind, in order", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a", 1, "put"), op("b", 2, "delete"), op("c", 3, "put")]);
    const { ops } = handleOpsByKind(store, "delete");
    expect(ops.map((o) => o.opId)).toEqual(["b"]);
    expect(ops[0]!.payload).toEqual({ n: 2 });
  });

  it("is empty for a kind nothing used", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a")]);
    expect(handleOpsByKind(store, "delete").ops).toEqual([]);
  });
});
