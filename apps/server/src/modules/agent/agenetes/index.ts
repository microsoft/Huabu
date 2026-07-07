/**
 * Agenetes — the in-process L1↔L2 seam (§3.6 / §7).
 *
 * The generic contracts (the `AgentHandle` execution seam + the driver
 * register/injection seam) now live in the host-agnostic
 * `@agenetes/runtime` package; `./handle.js` binds them to the host's
 * concrete request/transcript types and re-exports them. The standard ACP
 * driver (`AcpAgentHandle`) now lives in the `@agenetes/acp-driver`
 * subtree package and is re-exported here; the canvas-coupled built-in
 * driver stays host-owned. Both are injected into the runtime by
 * `./drivers.js` (object injection).
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
} from '@agenetes/acp-driver';
export {
  agenetes,
  builtinAgentDriver,
  getBuiltinDriver,
  BUILTIN_DRIVER_KIND,
  ACP_DRIVER_KIND,
  type AcpHandle,
  type AcpWorkloadSpec,
  type AcpCreateSpec,
  type BuiltinDriverInput,
  type BuiltinAgentDriver,
} from './drivers.js';
