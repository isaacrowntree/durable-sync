import { describe, it, expect } from "vitest";
import {
  MemoryOpStore,
  handlePush,
  handlePull,
  handleReset,
  handleOpsByKind,
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
