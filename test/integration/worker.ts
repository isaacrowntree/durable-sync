/** A Worker that forwards every request straight to one journal DO.
 *
 * Deliberately unlike the README's route handler: it exposes DELETE and every
 * other method, because the whole point of this suite is to exercise the DO's
 * real routing and real SQLite — not to model a safe public surface. It tests
 * `src`, so a regression is caught before a publish rather than after. */
import { SyncJournal } from "../../src/server/index.js";

export class Journal extends SyncJournal {}

/** The slice of the binding we use, typed locally so this file needs no
 * `@cloudflare/workers-types` (and it isn't covered by the src typecheck). */
interface Env {
  JOURNAL: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.JOURNAL.get(env.JOURNAL.idFromName("lifter"));
    const hasBody = req.method !== "GET" && req.method !== "DELETE";
    return stub.fetch(
      new Request(`https://journal${url.pathname}${url.search}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: hasBody ? await req.text() : undefined,
      }),
    );
  },
};
