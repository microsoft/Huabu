// @agenetes/runtime — the host-agnostic L2 agent-runtime framework.
// See ./handle.ts for the design rules and layering rationale.

export type { AgentHandle } from './handle.js';
export type {
  AgentDriver,
  AgentRuntime,
  DriverDefinition,
  DriverMap,
  MountedAgentDriver,
  RuntimeSchema,
  TypedWorkloadSpec,
} from './driver.js';
export { createAgentRuntime, defineDriver } from './driver.js';
export type {
  AgentCreateContext,
  AgentForkInput,
  AgentRecoveryInput,
  AgentRecoveryContext,
  HistoryLoadAuthorization,
  HistoryLoadAuthorizationInput,
  ThreadIdentity,
} from './realization.js';
export { HistoryLoadDeniedError } from './realization.js';
export { projectTextHistoryTurn } from './history.js';
export { AgenetesError } from './errors.js';
export type { AgenetesErrorCode } from './errors.js';
