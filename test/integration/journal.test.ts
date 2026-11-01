/** The journal against a real Durable Object.
 *
 * Every check here has a faster cousin in the unit suite. What only this suite
 * can catch is a statement that parses under node:sqlite but behaves
 * differently — or not at all — under the DO's SQLite, reached the way a
 * consumer reaches it: HTTP into a Worker, RPC into the DO. Storage is isolated per
 * test (see the config), so each test builds the log it needs. */
import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

type Json = Record<string, any>;

const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
  const res = await SELF.fetch(`https://journal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as Json;
};

const op = (opId: string, weight: number) => ({ opId, kind: "set.logged", payload: { weight } });
const seed = () => call("POST", "/push", { ops: [op("a", 100), op("b", 102.5), op("c", 105)] });

// The DO is a singleton addressed by one name, and per-test storage isolation
// doesn't roll back its SQLite here — so start every test from a truly empty
// log rather than trust the pool to do it. An erase drops ops, snapshot, and the
// epoch, which is exactly the clean slate each test wants.
beforeEach(() => call("DELETE", "/erase"));

describe("push", () => {
  it("assigns seqs and names what it stored", async () => {
    const r = await seed();
    expect(r.seq).toBe(3);
    expect(r.accepted).toBe(3);
    expect(r.stored).toEqual(["a", "b", "c"]);
  });

  /** The bug 0.2.0 fixes, end to end on real SQLite: a refused op must be
   * absent from `stored`, or the client drains the only copy of the write. */
  it("leaves a refused op out of stored", async () => {
    await seed();
    const r = await call("POST", "/push", {
      ops: [op("c", 105), { opId: "", kind: "set.logged", payload: {} }, op("d", 107.5)],
    });
    expect(r.stored).toEqual(["c", "d"]);
    expect(r.accepted).toBe(1); // only d is new; c is a duplicate, "" is refused
  });

  it("names a duplicate as stored even though it wasn't accepted", async () => {
    await seed();
    const r = await call("POST", "/push", { ops: [op("a", 100)] });
    expect(r.accepted).toBe(0);
    expect(r.stored).toEqual(["a"]);
  });
});

describe("pull", () => {
  it("returns the whole log, with payloads intact through DO SQLite", async () => {
    await seed();
    const r = await call("GET", "/pull?since=0");
    expect(r.ops.map((o: Json) => o.opId)).toEqual(["a", "b", "c"]);
    expect(r.ops[1].payload.weight).toBe(102.5);
    expect(typeof r.epoch).toBe("string");
    expect(r.epoch.length).toBeGreaterThan(0);
  });

  it("returns only the tail after a cursor", async () => {
    await seed();
    const r = await call("GET", "/pull?since=2");
    expect(r.ops.map((o: Json) => o.opId)).toEqual(["c"]);
  });
});

describe("snapshot", () => {
  const epochOf = async () => (await call("GET", "/pull?since=0")).epoch;

  it("is absent until a client folds the log", async () => {
    await seed();
    const r = await call("GET", "/pull?since=0&snapshot=1");
    expect(r.snapshot).toBeUndefined();
    expect(r.ops).toHaveLength(3);
  });

  it("round-trips a fold and serves only the tail after it", async () => {
    await seed();
    const epoch = await epochOf();
    const w = await call("PUT", "/snapshot", { seq: 2, epoch, blob: { v: 1, pr: 102.5 } });
    expect(w).toEqual({ ok: true, seq: 2 });

    const r = await call("GET", "/pull?since=0&snapshot=1");
    expect(r.snapshot.blob.pr).toBe(102.5);
    expect(r.ops.map((o: Json) => o.opId)).toEqual(["c"]);
    expect(r.seq).toBe(3);
  });

  it("withholds the fold from a caller that didn't ask", async () => {
    await seed();
    await call("PUT", "/snapshot", { seq: 2, epoch: await epochOf(), blob: {} });
    const r = await call("GET", "/pull?since=0");
    expect(r.snapshot).toBeUndefined();
    expect(r.ops).toHaveLength(3);
  });

  it("withholds the fold mid-log, where it would skip ops", async () => {
    await seed();
    await call("PUT", "/snapshot", { seq: 2, epoch: await epochOf(), blob: {} });
    const r = await call("GET", "/pull?since=1&snapshot=1");
    expect(r.snapshot).toBeUndefined();
    expect(r.ops.map((o: Json) => o.opId)).toEqual(["b", "c"]);
  });

  /** The ON CONFLICT upsert, on DO SQLite. */
  it("replaces an older fold with a newer one", async () => {
    await seed();
    const epoch = await epochOf();
    await call("PUT", "/snapshot", { seq: 2, epoch, blob: { pr: 102.5 } });
    const w = await call("PUT", "/snapshot", { seq: 3, epoch, blob: { pr: 105 } });
    expect(w).toEqual({ ok: true, seq: 3 });

    const r = await call("GET", "/pull?since=0&snapshot=1");
    expect(r.snapshot.blob.pr).toBe(105);
    expect(r.ops).toHaveLength(0);
  });

  it("keeps the newer fold when an older one arrives late", async () => {
    await seed();
    const epoch = await epochOf();
    await call("PUT", "/snapshot", { seq: 3, epoch, blob: { v: "new" } });
    const w = await call("PUT", "/snapshot", { seq: 1, epoch, blob: { v: "old" } });
    expect(w).toEqual({ ok: false, seq: 3 });
  });

  it("refuses a fold of ops it has never seen", async () => {
    await seed();
    const w = await call("PUT", "/snapshot", { seq: 99, epoch: await epochOf(), blob: {} });
    expect(w.ok).toBe(false);
  });
});

describe("eraseJournal", () => {
  it("refuses without the confirmation, and leaves the log alone", async () => {
    await seed();
    for (const confirm of ["", "yes", "true"]) {
      const r = await call("DELETE", `/erase?confirm=${confirm}`);
      expect(r.error).toMatch(/confirm/);
    }
    expect((await call("GET", "/?since=0")).ops).toHaveLength(3);
  });

  it("clears the log, drops the snapshot, and starts a new epoch", async () => {
    await seed();
    const before = (await call("GET", "/pull?since=0")).epoch;
    await call("PUT", "/snapshot", { seq: 2, epoch: before, blob: {} });

    const r = await call("DELETE", "/erase");
    expect(r.cleared).toBe(3);
    expect(r.epoch).not.toBe(before);

    const after = await call("GET", "/pull?since=0&snapshot=1");
    expect(after.snapshot).toBeUndefined();
    expect(after.ops).toHaveLength(0);
  });

  /** The dangerous one. A client that folded the old log and missed the reset
   * must not be able to hand every new device the state the reset destroyed. */
  it("refuses a fold from the generation it just discarded", async () => {
    await seed();
    const stale = (await call("GET", "/pull?since=0")).epoch;
    await call("DELETE", "/erase");
    await call("POST", "/push", { ops: [op("fresh", 60)] });

    const w = await call("PUT", "/snapshot", { seq: 1, epoch: stale, blob: { ghost: true } });
    expect(w.ok).toBe(false);

    const r = await call("GET", "/pull?since=0&snapshot=1");
    expect(r.snapshot).toBeUndefined();
    expect(r.ops.map((o: Json) => o.opId)).toEqual(["fresh"]);
  });

  it("frees a used opId for the rebuilt log", async () => {
    await seed();
    await call("DELETE", "/erase");
    const r = await call("POST", "/push", { ops: [op("a", 60)] });
    expect(r.accepted).toBe(1); // "a" existed in the old generation, not this one
  });
});

describe("ops by kind", () => {
  it("returns whole ops of one kind", async () => {
    await call("POST", "/push", {
      ops: [op("a", 100), { opId: "b", kind: "note", payload: { text: "hi" } }, op("c", 105)],
    });
    expect((await call("GET", "/ops?kind=set.logged")).ops).toHaveLength(2);
    expect((await call("GET", "/ops?kind=note")).ops).toHaveLength(1);
    expect((await call("GET", "/ops?kind=nothing")).ops).toHaveLength(0);
  });
});

describe("limits, on the DO's SQLite", () => {
  it("rejects an oversized op by name and stores the rest", async () => {
    const r = await call("POST", "/push", {
      ops: [{ opId: "big", kind: "set.logged", payload: "x".repeat(2000) }, op("a", 100)],
    });
    expect(r).toMatchObject({ stored: ["a"], rejected: ["big"] });
  });

  it("refuses past the journal's size, and frees it on reset", async () => {
    const chunk = (i: number) => ({ opId: `c${i}`, kind: "k", payload: "y".repeat(900) });
    const r = await call("POST", "/push", { ops: Array.from({ length: 30 }, (_, i) => chunk(i)) });
    expect(r.full).toBe(true);
    expect(r.stored.length).toBeGreaterThan(0);
    expect(r.stored.length).toBeLessThan(30);
    await call("DELETE", "/erase");
    expect((await call("POST", "/push", { ops: [chunk(99)] })).stored).toEqual(["c99"]);
  });

  it("refuses a push far past maxPushOps unread, across RPC", async () => {
    const ops = Array.from({ length: 4001 }, (_, i) => ({ opId: `x${i}`, kind: "k", payload: 0 }));
    expect(await call("POST", "/push", { ops })).toEqual({ seq: 0, accepted: 0, stored: [], rejected: [], tooMany: 1000 });
    expect((await call("GET", "/?since=0")).ops).toHaveLength(0);
  });

  it("pages a long log, and following seq visits every op", async () => {
    await call("POST", "/push", { ops: Array.from({ length: 120 }, (_, i) => op(`p${i}`, i)) });
    const first = await call("GET", "/?since=0");
    expect(first).toMatchObject({ seq: 50, more: true });
    expect(first.ops).toHaveLength(50);
    const seen: string[] = [];
    let since = 0;
    for (let i = 0; i < 10; i++) {
      const page = await call("GET", `/?since=${since}`);
      seen.push(...page.ops.map((o: Json) => o.opId));
      if (!page.more) break;
      since = page.seq;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });
});
