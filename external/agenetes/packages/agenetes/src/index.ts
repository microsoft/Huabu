// @agenetes/agenetes — the mounted Agenetes instance (L2 control-plane
// core). See ./instance.ts (I9.3 runtime + I9.4 query surfaces),
// ./builder.ts (I9.5 driver-factory-dictionary bootstrap), and
// ./thread-store.ts (the durable thread-table port).

export { mountAgenetes } from './builder.js';
export type {
  AgenetesBuilder,
  DriverFactory,
  MountAgenetesOptions,
} from './builder.js';

export { createAgenetesInstance } from './instance.js';
export type {
  Agenetes,
  WorkloadSpecShape,
  HistoryOptions,
  ThreadHistory,
} from './instance.js';

export { InMemoryThreadStore, FileThreadStore } from './thread-store.js';
export type { ThreadRecord, ThreadStore } from './thread-store.js';

export {
  EventLog,
  InMemoryEventLogStore,
  FileEventLogStore,
} from './event-log.js';
export type {
  EventLogEntry,
  EventLogStore,
  EventLogListener,
} from './event-log.js';

export { InMemoryTurnStore, FileTurnStore } from './turn-store.js';
export type { PersistedTurn, TurnStore } from './turn-store.js';
export { createTranscriptFolder } from './fold.js';
export type { TranscriptFolder } from './fold.js';

export {
  DEFAULT_AUTO_RECOVER_POLICY,
  createAgentRecoveryContext,
  estimateHistoryLoadSize,
} from './recovery.js';
export type {
  AutoRecoverPolicy,
  RecoveryConfirmationContext,
} from './recovery.js';
