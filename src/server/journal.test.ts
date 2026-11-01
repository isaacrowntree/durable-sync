import { describe, it, expect } from "vitest";
import {
  MemoryOpStore,
  handlePush,
  handlePull,
  handleErase,
  handleOpsByKind,
  handleSnapshot,
  DEFAULT_LIMITS,
  PUSH_REFUSE_FACTOR,
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

    const r = handleErase(store);

    expect(r.cleared).toBe(2);
    expect(r.epoch).not.toBe(before);
    expect(handlePull(store, 0).epoch).not.toBe(before);
  });

  it("a reset log rebuilds cleanly, and a used opId is free again", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("old")]);
    handleErase(store);

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
    handleErase(store);
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
    handleErase(store);
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

/** Anyone who can sign up can push, so every dimension a client controls is
 * bounded — and a refusal has to be one the client can act on. */
describe("limits", () => {
  const limits = (over: Partial<typeof DEFAULT_LIMITS>) => ({ ...DEFAULT_LIMITS, ...over });

  it("rejects, by name, ops it will never take as sent", () => {
    const store = new MemoryOpStore();
    const big = 1n;
    const r = handlePush(
      store,
      [
        { opId: "huge", kind: "put", payload: "x".repeat(100) },
        { opId: "x".repeat(20), kind: "put", payload: 1 },
        { opId: "kind", kind: "k".repeat(20), payload: 1 },
        { opId: "bigint", kind: "put", payload: { big } },
        op("good"),
      ],
      limits({ maxOpBytes: 50, maxOpIdLength: 10, maxKindLength: 10 }),
    );
    expect(r.stored).toEqual(["good"]);
    expect(r.rejected).toEqual(["huge", "x".repeat(20), "kind", "bigint"]);
    expect(handlePull(store, 0).ops.map((o) => o.opId)).toEqual(["good"]);
  });

  it("measures payloads in bytes, not characters", () => {
    const store = new MemoryOpStore();
    // 10 characters, 40 bytes.
    const r = handlePush(store, [{ opId: "emoji", kind: "put", payload: "😀".repeat(10) }], limits({ maxOpBytes: 30 }));
    expect(r.rejected).toEqual(["emoji"]);
  });

  it("considers at most maxPushOps a push, leaving the rest unnamed for next time", () => {
    const store = new MemoryOpStore();
    const r = handlePush(store, [op("a"), op("b"), op("c")], limits({ maxPushOps: 2 }));
    expect(r.stored).toEqual(["a", "b"]);
    expect(r.rejected).toEqual([]);
  });

  it("still takes a slice of a backlog up to PUSH_REFUSE_FACTOR times the limit", () => {
    const store = new MemoryOpStore();
    const ops = Array.from({ length: 2 * PUSH_REFUSE_FACTOR }, (_, i) => op(`o${i}`));
    const r = handlePush(store, ops, limits({ maxPushOps: 2 }));
    expect(r.stored).toEqual(["o0", "o1"]);
    expect(r.tooMany).toBeUndefined();
  });

  /** A push the journal could never take most of isn't worked through op by
   * op. It's refused whole — nothing stored, nothing named — and the reply
   * says how many to send instead. */
  it("refuses a push far past the limit unread, and says how many to send", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("before")]);
    const ops = Array.from({ length: 2 * PUSH_REFUSE_FACTOR + 1 }, (_, i) => op(`o${i}`));
    const r = handlePush(store, ops, limits({ maxPushOps: 2 }));
    expect(r).toEqual({ seq: 1, accepted: 0, stored: [], rejected: [], tooMany: 2 });
    expect(handlePull(store, 0).ops.map((o) => o.opId)).toEqual(["before"]);
  });

  it("stops at a full log, keeping order, and says so", () => {
    const store = new MemoryOpStore();
    const cap = limits({ maxJournalBytes: 30 }); // each op: 1 + 3 + 7 = 11 bytes
    const r = handlePush(store, [op("a"), op("b"), op("c"), op("d")], cap);
    expect(r).toMatchObject({ stored: ["a", "b"], rejected: [], full: true });
    expect(store.bytes()).toBe(22);
    // A later, smaller op doesn't jump the queue.
    expect(handlePush(store, [op("c"), { opId: "e", kind: "k", payload: 0 }], cap).stored).toEqual([]);
  });

  it("still names a held op as stored when the log is full", () => {
    const store = new MemoryOpStore();
    const cap = limits({ maxJournalBytes: 11 });
    handlePush(store, [op("a")], cap);
    expect(handlePush(store, [op("a"), op("b")], cap)).toMatchObject({ stored: ["a"], full: true });
  });

  it("frees the space on reset", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a")]);
    handleErase(store);
    expect(store.bytes()).toBe(0);
  });

  it("ignores a push that isn't a list", () => {
    const store = new MemoryOpStore();
    expect(handlePush(store, { length: 1, 0: op("a") } as never).stored).toEqual([]);
  });
});

/** A pull is one RPC and one response, so a long log comes a page at a time. */
describe("pull pages", () => {
  const five = () => {
    const store = new MemoryOpStore();
    handlePush(store, ["a", "b", "c", "d", "e"].map((id) => op(id)));
    return store;
  };
  const pages = (over: Partial<typeof DEFAULT_LIMITS>) => ({ ...DEFAULT_LIMITS, ...over });

  it("ends a page at maxPullOps, with seq the last op sent", () => {
    const store = five();
    const first = handlePull(store, 0, false, pages({ maxPullOps: 2 }));
    expect(first).toMatchObject({ seq: 2, more: true });
    expect(first.ops.map((o) => o.opId)).toEqual(["a", "b"]);
    const last = handlePull(store, 4, false, pages({ maxPullOps: 2 }));
    expect(last.ops.map((o) => o.opId)).toEqual(["e"]);
    expect(last.seq).toBe(5);
    expect(last.more).toBeUndefined();
  });

  /** The compatibility promise: a client from before paging stores `seq` and
   * asks from there, so following `seq` alone must visit every op. */
  it("visits every op for a client that only follows seq", () => {
    const store = five();
    const seen: string[] = [];
    let since = 0;
    for (let i = 0; i < 10; i++) {
      const r = handlePull(store, since, false, pages({ maxPullOps: 2 }));
      seen.push(...r.ops.map((o) => o.opId));
      if (r.seq === since) break;
      since = r.seq;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ends a page at maxPullBytes, but always sends at least one op", () => {
    const store = five(); // payload {"n":1} is 7 bytes
    expect(handlePull(store, 0, false, pages({ maxPullBytes: 15 })).ops).toHaveLength(2);
    expect(handlePull(store, 0, false, pages({ maxPullBytes: 1 })).ops).toHaveLength(1);
  });

  it("pages the tail after a snapshot", () => {
    const store = five();
    handleSnapshot(store, { seq: 1, epoch: store.epoch(), blob: {} });
    const r = handlePull(store, 0, true, pages({ maxPullOps: 2 }));
    expect(r.snapshot?.seq).toBe(1);
    expect(r.ops.map((o) => o.opId)).toEqual(["b", "c"]);
    expect(r).toMatchObject({ seq: 3, more: true });
  });
});

describe("opsByKind", () => {
  it("returns only that kind, in order", () => {
    const store = new MemoryOpStore();
    handlePush(store, [op("a", 1, "put"), op("b", 1, "del"), op("c", 1, "put")]);
    expect(handleOpsByKind(store, "put").ops.map((o) => o.opId)).toEqual(["a", "c"]);
  });
});
