/** A Worker that maps HTTP to the journal's RPC methods.
 *
 * This is exactly what a consumer writes — a route handler per method — so the
 * suite exercises the real path a client takes: HTTP into the Worker, RPC into
 * the DO. Deliberately unsafe: it also exposes reset, because the point here is
 * to reach every method, not to model a safe public surface. It tests `src`, so
 * a regression is caught before a publish. */
import { SyncJournal } from "../../src/server/index.js";

export class Journal extends SyncJournal {}

interface Env {
  JOURNAL: DurableObjectNamespace<Journal>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const journal = env.JOURNAL.get(env.JOURNAL.idFromName("lifter"));
    const json = <T>(value: T) => Response.json(value);

    if (req.method === "POST") {
      const { ops } = (await req.json()) as { ops: Parameters<Journal["push"]>[0] };
      return json(await journal.push(ops));
    }
    if (req.method === "PUT") {
      return json(await journal.putSnapshot((await req.json()) as never));
    }
    if (req.method === "DELETE") {
      return json(await journal.reset());
    }
    if (url.pathname === "/ops") {
      return json(await journal.opsByKind(url.searchParams.get("kind") ?? ""));
    }
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    return json(await journal.pull(since, url.searchParams.get("snapshot") === "1"));
  },
};
