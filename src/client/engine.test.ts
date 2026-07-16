import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSync, type SyncOptions } from "./engine.js";
import { memoryOutbox, memoryCursor } from "./adapters.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = () => json({ ops: [], seq: 1, epoch: "e1", accepted: 0 });

function make(over: Partial<SyncOptions> = {}, t = { value: 1_000_000 }) {
  const applied: string[] = [];
  const sync = createSync({
    outbox: memoryOutbox(),
    cursor: memoryCursor({ seq: 1, epoch: "e1" }), // epoch known: no replay
    apply: async (op) => {
      applied.push(op.opId);
      return true;
    },
    now: () => t.value,
    ...over,
  });
  return { sync, applied, t };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("syncNow", () => {
  it("pushes and pulls when nothing objects", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = make();

    await sync.now();
    expect(fetchMock).toHaveBeenCalled();
    expect(sync.getState().lastOkAt).toBe(1_000_000);
  });

  /** Applying a remote op can disturb work in progress — in the app this was
   * extracted from, a pull mid-workout rewrote the working weight that the
   * finish logic reads back, silently dropping a 5×5 to 3×5. Pushing is
   * always safe; pulling is not always safe. */
  it("pushes but never pulls while canPull() says no", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.method ?? "GET");
      return ok();
    }));
    const { sync } = make({ canPull: () => false });
    await sync.enqueue({ opId: "a", kind: "put", payload: {} });

    const applied = await sync.now();

    expect(seen).toEqual(["POST"]); // pushed, never pulled
    expect(applied).toBe(0);
    // A clean push is as synced as we can honestly claim.
    expect(sync.getState().lastOkAt).toBe(1_000_000);
  });

  it("does nothing at all when canWrite() says no", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = make({ canWrite: () => false });

    expect(await sync.now()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collapses overlapping calls into one sync", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = make();

    await Promise.all([sync.now(), sync.now(), sync.now()]);
    // One pull; the burst shares a single in-flight run.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles a burst of triggers arriving back to back", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const t = { value: 1_000_000 };
    const { sync } = make({ minIntervalMs: 10_000 }, t);

    await sync.now();
    t.value += 1_000; // same foregrounding
    await sync.now();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("syncs again once the throttle window passes", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const t = { value: 1_000_000 };
    const { sync } = make({ minIntervalMs: 10_000 }, t);

    await sync.now();
    t.value += 10_001;
    await sync.now();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** Every failure path is a silent catch — offline, a 500, an expired session —
 * because none of them should interrupt the user. The cost is that "synced"
 * and "silently broken for a week" look identical. This is the difference. */
describe("state", () => {
  it("never claims success when the journal was unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const { sync } = make();

    await sync.now();
    expect(sync.getState().lastOkAt).toBeUndefined();
    expect(sync.getState().lastError).toBeTruthy();
  });

  it("keeps the last good time when a later attempt fails", async () => {
    const t = { value: 1_000_000 };
    let healthy = true;
    vi.stubGlobal("fetch", vi.fn(async () =>
      healthy ? ok() : new Response("no", { status: 500 }),
    ));
    const { sync } = make({ minIntervalMs: 0 }, t);

    await sync.now();
    healthy = false;
    t.value += 60_000;
    await sync.now();

    const s = sync.getState();
    expect(s.lastOkAt).toBe(1_000_000); // still true — it DID sync then
    expect(s.lastError).toBeTruthy();
  });

  it("notifies subscribers, and stops after unsubscribe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const t = { value: 1_000_000 };
    const { sync } = make({ minIntervalMs: 0 }, t);
    const seen = vi.fn();
    const off = sync.subscribe(seen);

    await sync.now();
    expect(seen).toHaveBeenCalledTimes(1);

    off();
    t.value += 60_000;
    await sync.now();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("returns a stable snapshot reference until something changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const { sync } = make();

    const a = sync.getState();
    expect(sync.getState()).toBe(a); // useSyncExternalStore spins otherwise

    await sync.now();
    const b = sync.getState();
    expect(b).not.toBe(a);
    expect(sync.getState()).toBe(b);
  });
});
