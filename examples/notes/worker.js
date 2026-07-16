/** The whole server for an offline-first notes app.
 *
 * The journal is a Durable Object; this Worker is the only thing that can reach
 * it, so the surface a browser can touch is exactly the three routes below.
 * Note what isn't here: `journal.reset()`. The DO has it, nothing routes to it.
 * That is the access model — expose what you forward, and nothing else. */
import { SyncJournal } from "durable-sync/server";

export class Journal extends SyncJournal {}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/sync") {
      // One journal for the whole demo. A real app addresses it by the
      // signed-in identity — env.JOURNAL.idFromName(userId) — and that key is
      // the isolation boundary. There is no auth here; don't ship it like this.
      const journal = env.JOURNAL.get(env.JOURNAL.idFromName("demo"));

      if (req.method === "POST") {
        const { ops } = await req.json();
        return Response.json(await journal.push(ops));
      }
      if (req.method === "PUT") {
        return Response.json(await journal.putSnapshot(await req.json()));
      }
      if (req.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const withSnapshot = url.searchParams.get("snapshot") === "1";
        return Response.json(await journal.pull(since, withSnapshot));
      }
      return new Response("method not allowed", { status: 405 });
    }

    // Everything else is the static client.
    return env.ASSETS.fetch(req);
  },
};
