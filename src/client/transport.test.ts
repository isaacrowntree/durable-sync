import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTransport, type OutboxRow } from "./transport.js";
import { memoryOutbox, memoryCursor } from "./adapters.js";
import type { StoredOp } from "../server/journal.js";

function harness(over: { apply?: (op: StoredOp) => Promise<boolean> } = {}) {
  const outbox = memoryOutbox();
  const cursor = memoryCursor();
  const applied: StoredOp[] = [];
  const t = createTransport({
    outbox,
    cursor,
    apply:
      over.apply ??
      (async (op) => {
        applied.push(op);
        return true;
      }),
  });
  return { t, outbox, cursor, applied };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.unstubAllGlobals());

describe("push", () => {
  it("sends queued ops and drains the outbox on a real reply", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: { n: 1 } });
    vi.stubGlobal("fetch", vi.fn(async () => json({ seq: 1, accepted: 1 })));

    const r = await t.push();
    expect(r).toEqual({ ok: true, pushed: 1 });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("keeps ops queued when offline", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    expect(await t.push()).toEqual({ ok: false, pushed: 0 });
    expect(await outbox.list()).toHaveLength(1);
  });

  /** The bug this package exists to stop shipping. An expired auth-proxy
   * session redirects to a same-origin login page; fetch follows it and
   * reports 200. Draining on `res.ok` deletes the only copy of the write. */
  it("keeps ops queued when an auth proxy answers with a 200 login page", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!DOCTYPE html><title>Sign in</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    expect(await t.push()).toEqual({ ok: false, pushed: 0 });
    expect(await outbox.list()).toHaveLength(1);
  });

  it("does not double-queue the same opId", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    expect(await outbox.list()).toHaveLength(1);
  });

  it("an empty outbox is a success, not a failure", async () => {
    const { t } = harness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await t.push()).toEqual({ ok: true, pushed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pull", () => {
  it("applies ops and advances the cursor", async () => {
    const { t, cursor, applied } = harness();
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ ops: [{ seq: 1, opId: "a", kind: "put", payload: { n: 1 } }], seq: 1, epoch: "e1" }),
    ));

    expect(await t.pull()).toEqual({ ok: true, applied: 1 });
    expect(applied.map((o) => o.opId)).toEqual(["a"]);
    expect(await cursor.read()).toEqual({ seq: 1, epoch: "e1" });
  });

  it("asks only for ops after the cursor", async () => {
    const { t, cursor } = harness();
    await cursor.write({ seq: 7, epoch: "e1" });
    const fetchMock = vi.fn(async (_i: string | URL | Request) =>
      json({ ops: [], seq: 7, epoch: "e1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await t.pull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("since=7");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  /** A cursor is only meaningful against the log that issued it. After a reset
   * the rebuilt log restarts at seq 1, so a client still holding cursor 4 asks
   * for `seq > 4` and is told "nothing" — forever. */
  it("replays from zero when the log reports a new epoch", async () => {
    const { t, cursor, applied } = harness();
    await cursor.write({ seq: 4, epoch: "old-generation" });

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      const since = Number(new URL(url, "http://x").searchParams.get("since"));
      return json({
        ops: since < 1 ? [{ seq: 1, opId: "a", kind: "put", payload: {} }] : [],
        seq: 1,
        epoch: "new-generation",
      });
    }));

    const r = await t.pull();

    expect(seen.some((u) => u.includes("since=4"))).toBe(true);
    expect(seen.some((u) => u.includes("since=0"))).toBe(true);
    expect(r.applied).toBe(1);
    expect(applied.map((o) => o.opId)).toEqual(["a"]);
    expect(await cursor.read()).toEqual({ seq: 1, epoch: "new-generation" });
  });

  it("a client that has never synced replays once, then settles", async () => {
    const { t, cursor } = harness();
    const fetchMock = vi.fn(async () => json({ ops: [], seq: 3, epoch: "e1" }));
    vi.stubGlobal("fetch", fetchMock);

    await t.pull(); // no stored epoch → replay
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await cursor.read()).toEqual({ seq: 3, epoch: "e1" });

    await t.pull(); // epoch now known → single request
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("steps over an op that throws instead of wedging the cursor", async () => {
    const { t, cursor } = harness({
      apply: async (op) => {
        if (op.opId === "poison") throw new Error("corrupt");
        return true;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({
        ops: [
          { seq: 1, opId: "poison", kind: "put", payload: null },
          { seq: 2, opId: "good", kind: "put", payload: {} },
        ],
        seq: 2,
        epoch: "e1",
      }),
    ));

    const r = await t.pull();
    expect(r).toEqual({ ok: true, applied: 1 }); // the op behind it still landed
    expect((await cursor.read()).seq).toBe(2); // and we made progress
  });

  it("reports failure without moving the cursor when the journal is unreachable", async () => {
    const { t, cursor } = harness();
    await cursor.write({ seq: 2, epoch: "e1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    expect(await t.pull()).toEqual({ ok: false, applied: 0 });
    expect(await cursor.read()).toEqual({ seq: 2, epoch: "e1" });
  });

  it("treats a 200 login page as unreachable, not as an empty log", async () => {
    const { t, cursor } = harness();
    await cursor.write({ seq: 2, epoch: "e1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200 })));

    expect(await t.pull()).toEqual({ ok: false, applied: 0 });
    expect(await cursor.read()).toEqual({ seq: 2, epoch: "e1" });
  });
});

describe("OutboxRow", () => {
  it("keeps the store's own row key opaque", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    const rows: OutboxRow[] = await outbox.list();
    expect(rows[0]!.opId).toBe("a");
    expect(rows[0]).toHaveProperty("id");
  });
});
