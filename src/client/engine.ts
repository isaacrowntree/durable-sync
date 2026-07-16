/** Keeps a device converged without the user thinking about it.
 *
 * One sync per mount is never enough. An iOS home-screen PWA is frozen and
 * restored rather than remounted, so its mount effect can go days without
 * running again — you write on one device and the other never learns about it.
 * Every foregrounding is the real opportunity; mount is just one of them (it
 * still fires, because iOS cold-launches whenever the saved context is
 * evicted, which is often).
 *
 * There is no Background Sync in Safari, so nothing happens while the app is
 * closed. The honest goal is: converge promptly whenever the user is looking. */

import { createTransport, type TransportOptions } from "./transport.js";

export interface SyncState {
  /** When we last reached the journal. Absent = never, on this device. */
  lastOkAt?: number;
  /** Why the last attempt didn't land. Absent = the last attempt was fine. */
  lastError?: string;
}

export interface SyncOptions extends TransportOptions {
  /** Whether pulling is safe RIGHT NOW. Pushing always is.
   *
   * Use this when applying a remote op could disturb something the user is in
   * the middle of. Returning false pushes only and tries again later, which
   * eventual consistency makes free. */
  canPull?(): Promise<boolean> | boolean;
  /** Whether this device may sync at all — e.g. the signed-in identity still
   * matches the data being synced. Returning false does nothing, quietly. */
  canWrite?(): Promise<boolean> | boolean;
  /** localStorage key for the status shown to users. Omit to keep it in memory. */
  stateKey?: string;
  /** One foregrounding fires visibilitychange + focus + pageshow together;
   * collapse that burst into a single sync. */
  minIntervalMs?: number;
  /** Safety net only. iOS freezes timers in a backgrounded PWA, so this never
   * fires while the user is elsewhere — visibilitychange does that work. A
   * tighter interval just wakes the radio for nothing. */
  pollMs?: number;
  now?(): number;
}

const DEFAULT_MIN_INTERVAL = 10_000;
const DEFAULT_POLL = 5 * 60_000;
const UNREACHABLE = "Couldn't reach the sync journal";

export interface SyncNowOptions {
  /** Skip the throttle — for a write that just happened and shouldn't wait
   * out a foregrounding window. Never skips canWrite(). */
  force?: boolean;
}

export interface Sync {
  /** Push, then pull unless canPull() says no. Never throws. */
  now(opts?: SyncNowOptions): Promise<number>;
  /** Queue an op locally. Durable, no network — safe to await on a write path. */
  enqueue(op: { opId: string; kind: string; payload: unknown }): Promise<void>;
  /** Wire the lifecycle triggers. Returns a stop function. */
  start(): () => void;
  /** For React's useSyncExternalStore. The snapshot is referentially stable
   * between changes — returning a fresh object each call spins React. */
  subscribe(onChange: () => void): () => void;
  getState(): SyncState;
  /** The server snapshot for useSyncExternalStore. Nothing has synced during
   * SSR, and this MUST be referentially stable or React throws
   * "The result of getServerSnapshot should be cached to avoid an infinite
   * loop." Pass it as the third argument; never an inline `() => ({})`. */
  getServerState(): SyncState;
}

/** Frozen and shared: see getServerState. */
const SERVER_STATE: SyncState = Object.freeze({});

export function createSync(opts: SyncOptions): Sync {
  const {
    canPull = () => true,
    canWrite = () => true,
    stateKey,
    minIntervalMs = DEFAULT_MIN_INTERVAL,
    pollMs = DEFAULT_POLL,
    now = Date.now,
  } = opts;

  const transport = createTransport(opts);

  let inFlight: Promise<number> | null = null;
  let lastRunAt = 0;

  const listeners = new Set<() => void>();

  const loadPersisted = (): SyncState => {
    if (!stateKey || typeof localStorage === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(stateKey) ?? "{}") as SyncState;
    } catch {
      return {};
    }
  };

  let snapshot: SyncState = loadPersisted();

  function record(next: SyncState): void {
    snapshot = next;
    if (stateKey && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(stateKey, JSON.stringify(next));
      } catch {
        // private mode — losing the status is not worth failing a sync over
      }
    }
    for (const l of listeners) l();
  }

  async function run(): Promise<number> {
    const pushed = await transport.push();

    if (!(await canPull())) {
      // A clean push is as synced as we can honestly claim right now.
      record(pushed.ok ? { lastOkAt: now() } : { ...snapshot, lastError: UNREACHABLE });
      return 0;
    }

    const pulled = await transport.pull();
    record(
      pushed.ok && pulled.ok
        ? { lastOkAt: now() }
        : { ...snapshot, lastError: UNREACHABLE },
    );
    return pulled.applied;
  }

  async function syncNow(opts: SyncNowOptions = {}): Promise<number> {
    // The gate is checked first and force never skips it: filing one identity's
    // ops under another is unrecoverable, and the ack looks successful enough
    // to drain the outbox against it.
    if (!(await canWrite())) return 0;
    if (inFlight) return inFlight;
    if (!opts.force && now() - lastRunAt < minIntervalMs) return 0;
    // navigator.onLine is trustworthy only as a NEGATIVE — a dead zone with
    // full bars still reports true — so it's worth exactly this one check.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;

    inFlight = run();
    try {
      return await inFlight;
    } finally {
      lastRunAt = now();
      inFlight = null;
    }
  }

  function start(): () => void {
    // No document/window during SSR — and the caller may well be a module that
    // gets evaluated on the server.
    if (typeof document === "undefined" || typeof window === "undefined") {
      return () => {};
    }

    void syncNow(); // mount is still a real trigger: iOS cold-launches often

    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    // A tab restored from the bfcache doesn't fire visibilitychange.
    const onPageShow = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) void syncNow();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    const poll = setInterval(() => void syncNow(), pollMs);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      clearInterval(poll);
    };
  }

  return {
    now: syncNow,
    enqueue: transport.enqueue,
    start,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    getState: () => snapshot,
    getServerState: () => SERVER_STATE,
  };
}
