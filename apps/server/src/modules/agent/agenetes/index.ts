/**
 * Agenetes — the in-process L1↔L2 execution seam (§3.6 / §7 M2).
 *
 * Transitional location: the handle abstraction lands under
 * `modules/agent/agenetes/` now and relocates to `external/agenetes` once
 * M4/M5 decouple the host ports it currently reaches through the route.
 */

export type { AgentHandle, AgentRequest, RenderFn } from './handle.js';
export {
  BuiltinAgentHandle,
  type BuiltinRendered,
  type BuiltinAgentHandleOptions,
} from './builtin-handle.js';
export {
  AcpAgentHandle,
  type PreparedAcpPrompt,
  type AcpAgentHandleOptions,
} from './acp-handle.js';
