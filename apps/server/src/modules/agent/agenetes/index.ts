/**
 * Agenetes — the in-process L1↔L2 seam (§3.6 / §7).
 *
 * The generic contracts (the `AgentHandle` execution seam + the driver
 * register/injection seam) now live in the host-agnostic
 * `@agenetes/runtime` package; `./handle.js` binds them to the host's
 * concrete request/transcript types and re-exports them. The two concrete
 * driver implementations still live here and are injected into the runtime
 * by `./drivers.js` (object injection) until M4/M5 let the standard (ACP)
 * driver move into the subtree.
 */

export type {
  AgentHandle,
  AgentRequest,
  RenderFn,
  AgentDriver,
  AgentDriverInfo,
  AgentRuntime,
} from './handle.js';
export { createAgentRuntime } from './handle.js';
export {
  BuiltinAgentHandle,
  BUILTIN_CAPABILITIES,
  type BuiltinRendered,
  type BuiltinTurnCtx,
} from './builtin-handle.js';
export {
  AcpAgentHandle,
  ACP_CAPABILITIES,
  type PreparedAcpPrompt,
  type AcpTurnCtx,
} from './acp-handle.js';
export {
  agentRuntime,
  acquireAcpHandle,
  builtinAgentDriver,
  acpAgentDriver,
  getBuiltinDriver,
  getAcpDriver,
  BUILTIN_DRIVER_KIND,
  ACP_DRIVER_KIND,
  type AcpHandle,
  type BuiltinDriverInput,
  type AcpDriverInput,
  type BuiltinAgentDriver,
  type AcpAgentDriver,
} from './drivers.js';
