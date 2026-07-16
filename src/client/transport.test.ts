import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTransport, type OutboxRow, type SnapshotAdapter } from "./transport.js";
import { memoryOutbox, memoryCursor } from "./adapters.js";
import type { StoredOp } from "../server/journal.js";

function harness(
  over: { apply?: (op: StoredOp) => Promise<boolean>; snapshot?: SnapshotAdapter } = {},
) {
  const outbox = memoryOutbox();
  const cursor = memoryCursor();
  const applied: StoredOp[] = [];
  const t = createTransport({
    outbox,
    cursor,
    snapshot: over.snapshot,
    apply:
      over.apply ??
      (async (op) => {
        applied.push(op);
        return true;
      }),
  });
  return { t, outbox, cursor, applied };
}

/** Records what it was asked to restore, and can be told to refuse. */
function fakeSnapshot(over: { restore?: (blob: unknown) => boolean } = {}) {
  const restored: unknown[] = [];
  const adapter: SnapshotAdapter = {
    capture: () => ({ folded: true }),
    restore: (blob) => {
      restored.push(blob);
      return over.restore ? over.restore(blob) : true;
    },
  };
  return { adapter, restored };
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

  /** The same bug as the 200 login page, one layer in: a reply proves the
   * journal answered, not that it took every op. Draining an op it refused
   * deletes a write that will never exist anywhere. */
  it("keeps an op the journal refused, and drains the ones it took", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "good", kind: "put", payload: {} });
    await t.enqueue({ opId: "refused", kind: "put", payload: {} });
    vi.stubGlobal("fetch", vi.fn(async () => json({ seq: 1, accepted: 1, stored: ["good"] })));

    expect(await t.push()).toEqual({ ok: true, pushed: 1 });
    expect((await outbox.list()).map((r) => r.opId)).toEqual(["refused"]);
  });

  /** A duplicate is in the log even though it wasn't accepted — so it must
   * drain, or a push that was retried after a lost reply queues forever. */
  it("drains a duplicate the journal already had", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    vi.stubGlobal("fetch", vi.fn(async () => json({ seq: 5, accepted: 0, stored: ["a"] })));

    expect(await t.push()).toEqual({ ok: true, pushed: 1 });
    expect(await outbox.list()).toHaveLength(0);
  });

  /** A journal older than this client sends no `stored`. Nothing can be
   * inferred from its absence, so behave exactly as before rather than stall a
   * rollout where the Worker lags a cached PWA. */
  it("drains everything when the journal is too old to say what it stored", async () => {
    const { t, outbox } = harness();
    await t.enqueue({ opId: "a", kind: "put", payload: {} });
    vi.stubGlobal("fetch", vi.fn(async () => json({ seq: 1, accepted: 1 })));

    expect(await t.push()).toEqual({ ok: true, pushed: 1 });
    expect(await outbox.list()).toHaveLength(0);
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

describe("snapshot", () => {
  it("only asks for a fold on a cold start, and only if it can unfold one", async () => {
    const { adapter } = fakeSnapshot();

    const withAdapter = harness({ snapshot: adapter });
    const f1 = vi.fn(async (_i: string | URL | Request) => json({ ops: [], seq: 0, epoch: "e1" }));
    vi.stubGlobal("fetch", f1);
    await withAdapter.t.pull();
    expect(String(f1.mock.calls[0]?.[0])).toContain("snapshot=1");

    // Mid-log: we already have the head, so a fold would only skip ops.
    const midLog = harness({ snapshot: adapter });
    await midLog.cursor.write({ seq: 5, epoch: "e1" });
    const f2 = vi.fn(async (_i: string | URL | Request) => json({ ops: [], seq: 5, epoch: "e1" }));
    vi.stubGlobal("fetch", f2);
    await midLog.t.pull();
    expect(String(f2.mock.calls[0]?.[0])).not.toContain("snapshot=1");

    // No adapter: asking would get a tail we can't use.
    const noAdapter = harness();
    const f3 = vi.fn(async (_i: string | URL | Request) => json({ ops: [], seq: 0, epoch: "e1" }));
    vi.stubGlobal("fetch", f3);
    await noAdapter.t.pull();
    expect(String(f3.mock.calls[0]?.[0])).not.toContain("snapshot=1");
  });

  it("restores a fold and applies only the tail", async () => {
    const { adapter, restored } = fakeSnapshot();
    const { t, cursor, applied } = harness({ snapshot: adapter });
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({
        snapshot: { seq: 40_000, blob: { pr: 140 } },
        ops: [{ seq: 40_001, opId: "tail", kind: "set.logged", payload: {} }],
        seq: 40_001,
        epoch: "e1",
      }),
    ));

    const r = await t.pull();

    expect(restored).toEqual([{ pr: 140 }]);
    expect(applied.map((o) => o.opId)).toEqual(["tail"]); // not 40k ops
    expect(r).toEqual({ ok: true, applied: 1 });
    expect(await cursor.read()).toEqual({ seq: 40_001, epoch: "e1" });
  });

  /** A blob an older build can't read must cost a slow sync, not a broken one:
   * `ops` was a tail, so applying it onto un-restored state would leave a hole
   * at the front of history that nothing would ever fill. */
  it("replays the whole log when the fold is refused", async () => {
    const { adapter } = fakeSnapshot({ restore: () => false });
    const { t, applied } = harness({ snapshot: adapter });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("snapshot=1")) {
        return json({
          snapshot: { seq: 2, blob: { schema: "from-the-future" } },
          ops: [{ seq: 3, opId: "c", kind: "put", payload: {} }],
          seq: 3,
          epoch: "e1",
        });
      }
      return json({
        ops: [
          { seq: 1, opId: "a", kind: "put", payload: {} },
          { seq: 2, opId: "b", kind: "put", payload: {} },
          { seq: 3, opId: "c", kind: "put", payload: {} },
        ],
        seq: 3,
        epoch: "e1",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await t.pull();

    expect(applied.map((o) => o.opId)).toEqual(["a", "b", "c"]); // the hole is filled
    expect(r).toEqual({ ok: true, applied: 3 });
  });

  it("treats a restore that throws as a refusal", async () => {
    const adapter: SnapshotAdapter = {
      capture: () => ({}),
      restore: () => {
        throw new Error("corrupt blob");
      },
    };
    const { t, applied } = harness({ snapshot: adapter });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).includes("snapshot=1")
        ? json({ snapshot: { seq: 1, blob: null }, ops: [], seq: 2, epoch: "e1" })
        : json({
            ops: [
              { seq: 1, opId: "a", kind: "put", payload: {} },
              { seq: 2, opId: "b", kind: "put", payload: {} },
            ],
            seq: 2,
            epoch: "e1",
          }),
    ));

    expect(await t.pull()).toEqual({ ok: true, applied: 2 });
    expect(applied.map((o) => o.opId)).toEqual(["a", "b"]);
  });

  it("asks for a fold on the replay a new epoch forces", async () => {
    const { adapter } = fakeSnapshot();
    const { t, cursor } = harness({ snapshot: adapter });
    await cursor.write({ seq: 9, epoch: "old" });

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return json({ ops: [], seq: 0, epoch: "new" });
    }));

    await t.pull();
    expect(seen[0]).not.toContain("snapshot=1"); // mid-log, didn't know yet
    expect(seen[1]).toContain("since=0");
    expect(seen[1]).toContain("snapshot=1"); // the replay is the expensive one
  });

  describe("capture", () => {
    it("sends the fold with the seq and epoch it belongs to", async () => {
      const { adapter } = fakeSnapshot();
      const { t, cursor } = harness({ snapshot: adapter });
      await cursor.write({ seq: 12, epoch: "e1" });
      const fetchMock = vi.fn(async () => json({ ok: true, seq: 12 }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await t.capture()).toBe(true);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toEqual({
        seq: 12,
        epoch: "e1",
        blob: { folded: true },
      });
    });

    it("won't fold before anything has been pulled", async () => {
      const { adapter } = fakeSnapshot();
      const { t } = harness({ snapshot: adapter });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      expect(await t.capture()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is a no-op without an adapter", async () => {
      const { t } = harness();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect(await t.capture()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports failure rather than throwing when the journal refuses", async () => {
      const { adapter } = fakeSnapshot();
      const { t, cursor } = harness({ snapshot: adapter });
      await cursor.write({ seq: 3, epoch: "stale" });
      vi.stubGlobal("fetch", vi.fn(async () => json({ ok: false, seq: 9 })));
      expect(await t.capture()).toBe(false);
    });

    it("reports failure rather than throwing when offline", async () => {
      const { adapter } = fakeSnapshot();
      const { t, cursor } = harness({ snapshot: adapter });
      await cursor.write({ seq: 3, epoch: "e1" });
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("network down");
      }));
      expect(await t.capture()).toBe(false);
    });
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
