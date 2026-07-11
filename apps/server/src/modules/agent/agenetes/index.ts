/**
 * Agenetes — the in-process L1↔L2 seam (§3.6 / §7).
 *
 * The generic contracts (the `AgentHandle` execution seam + the driver
 * register/injection seam) now live in the host-agnostic
 * `@agenetes/runtime` package; `./handle.js` binds them to the host's
 * concrete request/transcript types and re-exports them. Standard drivers
 * now live in subtree packages (`@agenetes/acp-driver`,
 * `@agenetes/pi-driver`); the host keeps only the Huabu-specific adapter
 * layer that compiles requests/specs and injects ports into those drivers.
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
  AcpAgentHandle,
  ACP_CAPABILITIES,
  type PreparedAcpPrompt,
  type AcpTurnCtx,
} from '@agenetes/acp-driver';
export {
  PiAgentHandle,
  PI_DRIVER_CAPABILITIES,
  piCapabilitiesForWorkloadType,
  type PiRenderedInput,
  type PiTurnCtx,
  type PiWorkloadSpec,
  type PiDriverPorts,
} from '@agenetes/pi-driver';
export {
  agenetes,
  builtinDriverFactory,
  BUILTIN_FACTORY_NAME,
  INTERNAL_DRIVER_KIND,
  EXTERNAL_DRIVER_KIND,
  type AcpHandle,
  type BuiltinHandle,
  type AgenetesHandle,
  type AcpWorkloadSpec,
  type BuiltinWorkloadSpec,
  type AgenetesWorkloadSpec,
  type AcpCreateSpec,
} from './drivers.js';
export { buildForkTargetSpec } from './fork.js';
