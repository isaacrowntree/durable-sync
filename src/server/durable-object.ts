/** A ready-made Durable Object serving one user's op log.
 *
 * Address one instance per user — `ns.get(ns.idFromName(userKey))` — and the
 * platform gives you the thing everyone else needs a database for: a
 * single-threaded ordering point, per user, for free. */

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_LIMITS,
  SqlOpStore,
  handlePush,
  handlePull,
  handleErase,
  handleOpsByKind,
  handleSnapshot,
  type JournalLimits,
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
 * is the whole access model, with one exception built in: `eraseJournal`, the
 * only irreversible method, demands an argument no forwarded request carries,
 * so a route that dispatches by name can't reach it by accident.
 */
export class SyncJournal<Env = unknown> extends DurableObject<Env> {
  protected store: SqlOpStore;
  /** What this journal will take — see JournalLimits. Override to change. */
  protected limits: JournalLimits = DEFAULT_LIMITS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The DO's SQLite is the single-threaded consistency point. `SqlLike` is
    // the sliver of the SqlStorage API the log uses.
    this.store = new SqlOpStore(ctx.storage.sql as unknown as SqlLike);
  }

  /** Append ops. Idempotent by `opId`; returns the opIds the log now holds. */
  push(ops: JournalOp[]): PushResult {
    return handlePush(this.store, ops ?? [], this.limits);
  }

  /** Ops after `since`, a page at a time (`more` says there's another). Pass `withSnapshot` on a cold start (`since` 0)
   * to get `{ snapshot, ops }` where `ops` is the tail — see the client. */
  pull(since: number, withSnapshot = false): PullResult {
    return handlePull(this.store, Number(since) || 0, withSnapshot, this.limits);
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

  /** Empty the log, drop its snapshot and start a new epoch. Cannot be undone.
   *
   * The escape hatch for an append-only log, and the way to delete an
   * account's data. Named apart from the client protocol and refused without
   * `{ confirm: "erase" }`, so a route that forwards journal methods by name —
   * `journal[action](...)` — can't empty a log on a client's say-so. Call it
   * from maintenance code that names it; never forward it. */
  eraseJournal(options: { confirm: "erase" }): { cleared: number; epoch: string } {
    if (options?.confirm !== "erase") {
      throw new Error('durable-sync: eraseJournal needs { confirm: "erase" } — it empties the log for good');
    }
    return handleErase(this.store);
  }
}
