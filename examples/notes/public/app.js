/** The browser half of the notes app.
 *
 * Everything a real offline-first client needs and nothing it doesn't: a local
 * notes store, a durable outbox in IndexedDB, and durable-sync wiring the two
 * to the server. Writing is local-first — commit locally, queue the op, let the
 * network catch up whenever it exists. */
import { createSync, localStorageCursor } from "/lib/client/index.js";

// ── a tiny IndexedDB: the notes themselves, and the outbox ──────────────────
//
// The outbox MUST be durable. Until a push is acknowledged it may hold the only
// copy of a write, and memory doesn't survive a reload or the OS killing a
// backgrounded tab. That's the whole reason it lives here and not in a variable.

const DB_NAME = "durable-sync-notes";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("notes", { keyPath: "id" });
      const outbox = db.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
      outbox.createIndex("opId", "opId", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbReady = openDb();

function tx(store, mode, fn) {
  return dbReady.then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      }),
  );
}

const notes = {
  put: (note) => tx("notes", "readwrite", (s) => s.put(note)),
  get: (id) => tx("notes", "readonly", (s) => s.get(id)),
  all: () => tx("notes", "readonly", (s) => s.getAll()),
  clear: () => tx("notes", "readwrite", (s) => s.clear()),
};

// The OutboxStore contract durable-sync expects, over the object store above.
const outbox = {
  add: (op) => tx("outbox", "readwrite", (s) => s.add(op)),
  list: () => tx("outbox", "readonly", (s) => s.getAll()),
  remove: (ids) =>
    tx("outbox", "readwrite", (s) => {
      for (const id of ids) s.delete(id);
    }),
  has: (opId) =>
    tx("outbox", "readonly", (s) => s.index("opId").count(IDBKeyRange.only(opId))).then(
      (n) => n > 0,
    ),
};

// ── the sync engine ─────────────────────────────────────────────────────────

const sync = createSync({
  endpoint: "/api/sync",
  outbox,
  cursor: localStorageCursor("notes.cursor"),
  stateKey: "notes.syncState",

  // Idempotent by construction: an op can arrive more than once (a replay after
  // a reset, a retry, two tabs). Applying the same note twice is a no-op.
  async apply(op) {
    if (op.kind !== "note") return false;
    const note = op.payload;
    const existing = await notes.get(note.id);
    if (existing && existing.text === note.text) return false;
    await notes.put(note);
    return true;
  },

  // Fold the whole notes list into one blob, so a new device doesn't replay
  // every op. Versioned: restore refuses a shape it doesn't know and the client
  // replays the log instead — slow, but always correct.
  snapshot: {
    capture: async () => ({ v: 1, notes: await notes.all() }),
    async restore(blob) {
      if (blob?.v !== 1) return false;
      await notes.clear();
      for (const note of blob.notes) await notes.put(note);
      return true;
    },
  },
});

// ── UI ──────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();

async function render() {
  const all = (await notes.all()).sort((a, b) => b.at - a.at);
  $("notes").innerHTML =
    all.length === 0
      ? `<li class="empty">No notes yet. Add one — then go offline and add more.</li>`
      : all.map((n) => `<li><span>${escape(n.text)}</span><time>${when(n.at)}</time></li>`).join("");

  const queued = (await outbox.list()).length;
  $("queued").textContent = queued === 0 ? "outbox empty" : `${queued} queued`;
  $("queued").dataset.pending = queued > 0;
}

function renderStatus() {
  const s = sync.getState();
  const row = $("status");
  if (s.lastError) {
    row.dataset.state = "error";
    row.textContent = `not synced — ${s.lastError}`;
  } else if (s.lastOkAt) {
    row.dataset.state = "ok";
    row.textContent = `synced ${when(s.lastOkAt)}`;
  } else {
    row.dataset.state = "idle";
    row.textContent = "not synced yet";
  }
}

async function addNote(text) {
  const note = { id: uid(), text, at: Date.now() };
  // Local-first: commit, queue, then fire-and-forget the network.
  await notes.put(note);
  await sync.enqueue({ opId: note.id, kind: "note", payload: note });
  await render();
  void sync.now({ force: true }); // never awaited on the user's path
}

// A demo affordance: flip window.fetch to simulate the network dropping, so you
// can watch the outbox fill offline and drain on reconnect without DevTools.
let online = true;
const realFetch = window.fetch.bind(window);
window.fetch = (...args) =>
  online ? realFetch(...args) : Promise.reject(new TypeError("offline (demo)"));

function setOnline(next) {
  online = next;
  $("net").dataset.online = String(next);
  $("net").textContent = next ? "◉ Online" : "◌ Offline";
  if (next) void sync.now({ force: true });
}

$("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await addNote(text);
});

$("net").addEventListener("click", () => setOnline(!online));

$("fold").addEventListener("click", async () => {
  const ok = await sync.capture();
  flash($("fold"), ok ? "Folded ✓" : "Nothing to fold");
});

// Small helpers.
function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function when(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
function flash(el, msg) {
  const original = el.textContent;
  el.textContent = msg;
  setTimeout(() => (el.textContent = original), 1400);
}

sync.subscribe(renderStatus);
sync.start(); // wires visibilitychange / focus / online + poll
setInterval(render, 1000); // keep the "Xs ago" and outbox count live
render();
renderStatus();
