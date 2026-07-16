/** A ready-made Durable Object serving one user's op log.
 *
 * Address one instance per user — `ns.get(ns.idFromName(userKey))` — and the
 * platform gives you the thing everyone else needs a database for: a
 * single-threaded ordering point, per user, for free. */

import {
  SqlOpStore,
  handlePush,
  handlePull,
  handleReset,
  handleOpsByKind,
  type JournalOp,
  type SqlLike,
} from "./journal.js";

/** The slice of DurableObjectState this needs. Declared rather than imported
 * so the package doesn't depend on Workers types. */
export interface JournalState {
  storage: { sql: SqlLike };
}

/**
 * Extend this and export it from your Worker:
 *
 * ```ts
 * import { SyncJournal } from "durable-sync/server";
 * export class MyJournal extends SyncJournal {}
 * ```
 *
 * Routes (reachable only through a binding — expose what you want publicly):
 * - `POST   /push`            `{ ops }` → `{ seq, accepted }`
 * - `GET    /pull?since=N`             → `{ ops, seq, epoch }`
 * - `GET    /ops?kind=K`               → `{ ops }`
 * - `DELETE /reset`                    → `{ cleared, epoch }`
 */
export class SyncJournal {
  protected store: SqlOpStore;

  constructor(state: JournalState) {
    this.store = new SqlOpStore(state.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { ops?: JournalOp[] } | null;
      return Response.json(handlePush(this.store, body?.ops ?? []));
    }

    // Maintenance escape hatch for an append-only log. Deliberately on DELETE:
    // route only the methods you want reachable from the public internet.
    if (request.method === "DELETE") {
      return Response.json(handleReset(this.store));
    }

    if (url.pathname === "/ops") {
      return Response.json(handleOpsByKind(this.store, url.searchParams.get("kind") ?? ""));
    }

    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    return Response.json(handlePull(this.store, since));
  }
}
