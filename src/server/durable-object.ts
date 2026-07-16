/** A ready-made Durable Object serving one user's op log.
 *
 * Address one instance per user — `ns.get(ns.idFromName(userKey))` — and the
 * platform gives you the thing everyone else needs a database for: a
 * single-threaded ordering point, per user, for free. */

import { DurableObject } from "cloudflare:workers";
import {
  SqlOpStore,
  handlePush,
  handlePull,
  handleReset,
  handleOpsByKind,
  handleSnapshot,
  type JournalOp,
  type PushResult,
  type PullResult,
  type SnapshotResult,
  type StoredOp,
  type SqlLike,
} from "./journal.js";

/**
 * Extend this and export it from your Worker:
 *
 * ```ts
 * import { SyncJournal } from "durable-sync/server";
 * export class Journal extends SyncJournal {}
 * ```
 *
 * The methods below are Durable Object RPC — you call them on the stub, typed,
 * with no request-building or JSON in between:
 *
 * ```ts
 * const journal = env.JOURNAL.get(env.JOURNAL.idFromName(userKey));
 * const { seq, stored } = await journal.push(ops);
 * ```
 *
 * The stub is reachable only from your own Worker, so the surface a *client*
 * can touch is whatever you forward from an HTTP route and nothing else. That
 * is the whole access model: `reset()` is as callable as `push()` here, and
 * stays private simply by never being wired to a public route. There is no
 * router in this class second-guessing you.
 */
export class SyncJournal<Env = unknown> extends DurableObject<Env> {
  protected store: SqlOpStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The DO's SQLite is the single-threaded consistency point. `SqlLike` is
    // the sliver of the SqlStorage API the log uses.
    this.store = new SqlOpStore(ctx.storage.sql as unknown as SqlLike);
  }

  /** Append ops. Idempotent by `opId`; returns the opIds the log now holds. */
  push(ops: JournalOp[]): PushResult {
    return handlePush(this.store, ops ?? []);
  }

  /** Everything after `since`. Pass `withSnapshot` on a cold start (`since` 0)
   * to get `{ snapshot, ops }` where `ops` is the tail — see the client. */
  pull(since: number, withSnapshot = false): PullResult {
    return handlePull(this.store, Number(since) || 0, withSnapshot);
  }

  /** Store a client's fold of the log. Refused if it's stale — see
   * `handleSnapshot`. */
  putSnapshot(snap: { seq?: unknown; epoch?: unknown; blob?: unknown }): SnapshotResult {
    return handleSnapshot(this.store, snap ?? {});
  }

  /** Whole ops of one kind — for a caller that must interpret payloads the log
   * won't. */
  opsByKind(kind: string): { ops: StoredOp[] } {
    return handleOpsByKind(this.store, kind ?? "");
  }

  /** Empty the log and start a new epoch. The maintenance escape hatch for an
   * append-only log: never wire it to a public route. */
  reset(): { cleared: number; epoch: string } {
    return handleReset(this.store);
  }
}
