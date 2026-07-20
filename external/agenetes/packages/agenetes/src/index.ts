// @agenetes/agenetes — the mounted Agenetes instance (L2 control-plane
// core). See ./instance.ts (I9.3 runtime + I9.4 query surfaces),
// ./mount.ts (I9.5 static DriverMap composition), and
// ./thread-store.ts (the durable thread-table port).

export { mountAgenetes } from './mount.js';
export type { MountAgenetesOptions } from './mount.js';

export { createAgenetesInstance } from './instance.js';
export type {
  Agenetes,
  HistoryOptions,
  ThreadHistory,
  ThreadLogMetadata,
} from './instance.js';

export {
  InMemoryThreadStore,
  FileThreadStore,
  THREAD_STORE_SCHEMA_VERSION,
} from './thread-store.js';
export type { ThreadRecord, ThreadStore } from './thread-store.js';

export {
  EventLog,
  InMemoryEventLogStore,
  FileEventLogStore,
} from './event-log.js';
export type {
  EventLogEntry,
  EventLogRecord,
  EventLogStore,
  EventLogListener,
  TurnStartLogEntry,
} from './event-log.js';

export { InMemoryTurnStore, FileTurnStore } from './turn-store.js';
export type { PersistedTurn, TurnStore } from './turn-store.js';
export { createTranscriptFolder } from './fold.js';
export type { TranscriptFolder } from './fold.js';
export { materializeHistory } from './materialize-history.js';

export {
  DEFAULT_AUTO_RECOVER_POLICY,
  createAgentRecoveryContext,
  estimateHistoryLoadSize,
} from './recovery.js';
export type {
  AutoRecoverPolicy,
  RecoveryConfirmationContext,
} from './recovery.js';
