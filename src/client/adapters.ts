/** Storage adapters.
 *
 * The package ships the two that need no dependency. Your outbox should be
 * backed by IndexedDB in production — see the README for a ~15-line Dexie
 * adapter — because until a push is acknowledged the outbox may hold the only
 * copy of a write, and memory doesn't survive iOS killing a backgrounded PWA. */

import type { Cursor, CursorStore, OutboxRow, OutboxStore } from "./transport.js";

/** localStorage-backed cursor. Small, synchronous, and survives a reload —
 * which is all a cursor needs.
 *
 * Note it is NOT suitable for the outbox: a cursor can be rebuilt (the epoch
 * check replays from 0), but a lost outbox row is a lost write. */
export function localStorageCursor(key: string): CursorStore {
  return {
    read(): Cursor {
      if (typeof localStorage === "undefined") return { seq: 0 };
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return { seq: 0 };
        const parsed = JSON.parse(raw) as Cursor;
        return { seq: Number(parsed.seq) || 0, epoch: parsed.epoch };
      } catch {
        return { seq: 0 };
      }
    },
    write(cursor: Cursor): void {
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.setItem(key, JSON.stringify(cursor));
      } catch {
        // private mode — a lost cursor costs a replay, not data
      }
    },
  };
}

/** In-memory cursor — tests. */
export function memoryCursor(initial: Cursor = { seq: 0 }): CursorStore {
  let cursor = initial;
  return {
    read: () => cursor,
    write: (next) => void (cursor = next),
  };
}

/** In-memory outbox — TESTS ONLY. Loses writes on reload; use IndexedDB. */
export function memoryOutbox(): OutboxStore {
  let rows: OutboxRow[] = [];
  let nextId = 1;
  return {
    async add(op) {
      rows.push({ id: nextId++, ...op });
    },
    async list() {
      return [...rows];
    },
    async remove(ids) {
      const dead = new Set(ids);
      rows = rows.filter((r) => !dead.has(r.id));
    },
    async has(opId) {
      return rows.some((r) => r.opId === opId);
    },
  };
}
