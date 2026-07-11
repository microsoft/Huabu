// @agenetes/runtime — the host-agnostic L2 agent-runtime framework.
// See ./handle.ts for the design rules and layering rationale.

export type { AgentHandle, AgentTurnState, RenderFn } from './handle.js';
export type { AgentDriver, AgentRuntime } from './driver.js';
export { createAgentRuntime } from './driver.js';
export type {
  AgentCreateContext,
  AgentDurableInput,
  AgentDurableRecord,
  AgentRealizationMode,
  AgentRecoveryContext,
  HistoryLoadAuthorization,
  HistoryLoadAuthorizationInput,
  ThreadIdentity,
} from './realization.js';
export {
  classifyAgentRealization,
  HistoryLoadDeniedError,
} from './realization.js';
