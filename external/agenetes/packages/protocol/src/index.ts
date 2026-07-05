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
// per-turn request. The request is plain data; rendering to AgentInput is a
// separate concern a driver's submit(request, render) receives explicitly.
export { defineRequest, composeRequest } from './request.js';
export type {
  AgentInput,
  Renderer,
  RequestVariantSchema,
  RequestDefinition,
  AnyRequestDefinition,
  ComposedRequest,
} from './request.js';

// AgentStreamEvent (§3.6 / §5): the driver-agnostic L2->L1 event stream.
// The thin `{ type, data }` envelope is owned here; ACP-shaped payloads
// reference the ACP SDK's zod. Host-specific fields (meta.mode,
// tool_call.internalToolName) are host extensions, not upstream.
export {
  AGENT_STREAM_EVENTS,
  agentStreamEventSchema,
  metaEventDataSchema,
  textDeltaEventDataSchema,
  thinkingDeltaEventDataSchema,
  toolCallEventDataSchema,
  toolCallUpdateEventDataSchema,
  planEventDataSchema,
  permissionRequestEventDataSchema,
  configOptionsUpdateEventDataSchema,
  sessionModeUpdateEventDataSchema,
  sessionInfoUpdateEventDataSchema,
  sessionUsageUpdateEventDataSchema,
  doneEventDataSchema,
  errorEventDataSchema,
  endEventDataSchema,
} from './stream-event.js';
export type { AgentStreamEvent, AgentStreamEventType } from './stream-event.js';

// ControlMsg + AgentCapabilities (§3.6.2): the host->agent control plane.
// A closed { type, data } vocabulary symmetric with AgentStreamEvent on the
// duplex channel; AgentCapabilities is the serializable descriptor that
// gates which control ops an agent honours.
export {
  CONTROL_MSGS,
  controlMsgTypeSchema,
  controlMsgSchema,
  cancelControlDataSchema,
  setModeControlDataSchema,
  setModelControlDataSchema,
  setConfigOptionControlDataSchema,
  answerPermissionControlDataSchema,
  controlAckSchema,
  agentCapabilitiesSchema,
} from './control.js';
export type {
  ControlMsgType,
  ControlMsg,
  ControlAck,
  AgentCapabilities,
} from './control.js';

// Agentlet daemon status (M4): the wire snapshot the L2 control plane
// surfaces about the single embedded agentlet it supervises. Browser-safe
// (zod-only) so L1's UI can consume it transitively through
// @sediment/shared without depending on the fastify-bound host package.
export { agentletStatusSchema } from './agentlet-status.js';
export type { AgentletStatus } from './agentlet-status.js';
