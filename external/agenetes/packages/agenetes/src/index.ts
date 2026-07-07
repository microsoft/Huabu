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
export type { Agenetes, WorkloadSpecShape } from './instance.js';

export {
  AgentPersistentState,
  InMemoryThreadStore,
  FileThreadStore,
} from './thread-store.js';
export type { ThreadRecord, ThreadStore } from './thread-store.js';
