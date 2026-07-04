// @agenetes/protocol — the frozen L1<->L2 contract for the Agenetes
// agent control plane ("Agent-as-a-Local-Service").
//
// This package is the single source of truth for the wire vocabulary
// that crosses the L1 (Huabu human-AI interface) <-> L2 (Agenetes
// control plane) seam: `WorkloadSpec`, `ControlMsg`, `AgentStreamEvent`,
// `AgentCapabilities`, and the two-level identity contract (threadId /
// sessionId). See docs/proposals/layered-architecture.md §5 / §7 (M1).
//
// Design rules for this package (why it lives in the agenetes subtree,
// not in @sediment/shared):
//   - It is owned by L2 and consumed by L1 — the same relationship
//     @agentlet/protocol has with its clients. A second L2 implementation
//     must be able to satisfy these contracts unchanged.
//   - It must stay host-agnostic: it depends ONLY on `zod` (+ the ACP
//     SDK for tool shapes, added when those contracts land). It must not
//     import `@sediment/shared` or any canvas/Huabu-specific type.
//   - Every contract is a zod schema; the TS type is derived via
//     `z.infer` so the validator and the type can never drift. Inbound
//     (L1->L2) messages are validated with `safeParse` at the seam;
//     consumers that must stay zod-free (the web bundle) import the
//     derived types with `import type` only.

/**
 * Contract version for the Agenetes L1<->L2 protocol. Bump on any
 * breaking change to the wire schemas exported from this package.
 */
export const AGENETES_PROTOCOL_VERSION = '0.1.0';

// Two-level identity contract (§8).
export { threadIdSchema, sessionIdSchema } from './identity.js';
export type { ThreadId, SessionId } from './identity.js';

// WorkloadSpec building blocks (§3.6.1): the protocol ships the blocks,
// the host composes the closed union.
export {
  workloadKindSchema,
  defineBinding,
  composeWorkloadSpec,
} from './workload.js';
export type {
  WorkloadKind,
  BindingDefinition,
  AnyBindingDefinition,
  BindingMemberSchema,
  WorkloadSpecSchema,
} from './workload.js';

// AgentRequest building blocks (§3.6.1): the polymorphic, driver-agnostic
// per-turn request contract. render() is called inside a driver's submit();
// serialize() feeds the durable log.
export { defineRequest, composeRequest } from './request.js';
export type {
  AgentInput,
  Renderable,
  Serializable,
  AgentRequest,
  RequestVariantSchema,
  RequestDefinition,
  AnyRequestDefinition,
  RequestSchema,
} from './request.js';
