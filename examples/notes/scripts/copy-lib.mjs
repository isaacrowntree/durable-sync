/** Copies durable-sync's built browser client into public/lib, so the page can
 * `import` it directly — no bundler in this example. Runs on postinstall. */
import { cp, mkdir, access } from "node:fs/promises";

const src = new URL("../node_modules/durable-sync/dist/client/", import.meta.url);
const dest = new URL("../public/lib/client/", import.meta.url);

try {
  await access(src);
} catch {
  console.error("durable-sync not installed yet — run `npm install` first.");
  process.exit(1);
}

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log("copied durable-sync client → public/lib/client");
