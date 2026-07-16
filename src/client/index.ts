// createTransport is deliberately NOT exported. Reaching past createSync to
// the transport bypasses canWrite() — which is exactly how the app this came
// from posted one user's workouts to another's journal and drained the outbox
// against the ack. The gate is the only door.
export {
  type OutboxStore,
  type OutboxRow,
  type CursorStore,
  type Cursor,
  type TransportOptions,
  type PushOutcome,
  type PullOutcome,
  type SnapshotAdapter,
} from "./transport.js";

export {
  createSync,
  type Sync,
  type SyncOptions,
  type SyncNowOptions,
  type SyncState,
} from "./engine.js";

export { localStorageCursor, memoryCursor, memoryOutbox } from "./adapters.js";

export type { StoredOp, JournalOp, Snapshot } from "../server/journal.js";
