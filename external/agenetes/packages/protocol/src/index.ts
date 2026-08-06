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
// not in @huabu/shared):
//   - It is owned by L2 and consumed by L1 — the same relationship
//     @agentlet/protocol has with its clients. A second L2 implementation
//     must be able to satisfy these contracts unchanged.
//   - It must stay host-agnostic: it depends ONLY on `zod` (+ the ACP
//     SDK for tool shapes, added when those contracts land). It must not
//     import `@huabu/shared` or any canvas/Huabu-specific type.
//   - Every contract is a zod schema; the TS type is derived via
//     `z.infer` so the validator and the type can never drift. Inbound
//     (L1->L2) messages are validated with `safeParse` at the seam;
//     consumers that must stay zod-free (the web bundle) import the
//     derived types with `import type` only.

/**
 * Contract version for the Agenetes L1<->L2 protocol. Bump on any
 * breaking change to the wire schemas exported from this package.
 */
export const AGENETES_PROTOCOL_VERSION = '0.3.0';

// Two-level identity contract (§8).
export { threadIdSchema, sessionIdSchema } from './identity.js';
export type { ThreadId, SessionId } from './identity.js';

// Namespace (§7 M5.0 / §8): the storage/metadata isolation scope above
// threadId. Pure data L2 persists under but never interprets.
export { namespaceSchema } from './namespace.js';
export type { Namespace } from './namespace.js';

// WorkloadSpec: one opaque envelope; selected drivers validate nested specs.
export {
  workloadTypeSchema,
  agentSpecSchema,
  workloadSpecSchema,
} from './workload.js';
export type { WorkloadType, AgentSpec, WorkloadSpec } from './workload.js';

// AgentSubmission: durable host source data plus optional canonical inputs.
// Host rendering is complete before run(); drivers lower AgentInput[] into
// their backend-native form.
export {
  agentInputPartSchema,
  agentTextInputSchema,
  agentPartsInputSchema,
  agentCommandInputSchema,
  agentInputSchema,
  agentSubmissionSchema,
  resolveAgentInputs,
} from './request.js';
export type {
  AgentInputPart,
  AgentTextInput,
  AgentPartsInput,
  AgentCommandInput,
  AgentInput,
  AgentSubmission,
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

// AgentTurn (M5.6 / README I9.8): the FOLDED twin of AgentStreamEvent —
// one immutable Tier-2 record per completed run(), produced by L2 folding
// a turn's Tier-1 event range + the run's return transcript. The folded
// `{ type, data }` FoldedMessage union reuses the stream per-event data
// schemas (same vocabulary, accumulated form). Skeleton (C1); the folded
// vocabulary is refined as the fold (C3) and driver translators (C4/C5)
// land.
export {
  FOLDED_MESSAGE_TYPES,
  foldedMessageSchema,
  foldedTextDataSchema,
  foldedThinkingDataSchema,
  foldedToolCallDataSchema,
  foldedPlanDataSchema,
  foldedErrorDataSchema,
  agentTurnMetaSchema,
  agentTurnSchema,
} from './turn.js';
export type {
  FoldedMessage,
  FoldedMessageType,
  AgentTurn,
  AgentTurnMeta,
  ObservedAgentTurn,
} from './turn.js';

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
  setContextControlDataSchema,
  controlAckSchema,
  agentCapabilitiesSchema,
} from './control.js';
export type {
  ControlMsgType,
  ControlMsg,
  ControlAck,
  AgentCapabilities,
} from './control.js';

// AgentMetadata (§5 / M5.5): the driver-neutral *state* snapshot the
// control plane acts on — the folded value of the agent's selectable /
// usage surface. Companion of ControlMsg (mutates it) and the
// AgentStreamEvent `*_update` frames (fold into it); persisted on
// AgentPersistentState behind the ThreadStore port and consumed uniformly
// by L1 (e.g. the profile-schema cache).
export { agentMetadataSchema } from './agent-metadata.js';
export type { AgentMetadata } from './agent-metadata.js';

// AgentStateSnapshot (§5 / M5.5 / README I9.7): the full driver-owned durable
// state plus common metadata that the handle up-reports and the instance
// persists as `ThreadRecord.state`. Never a per-field delta.
export { agentStateSnapshotSchema } from './agent-state.js';
export type { AgentStateSnapshot } from './agent-state.js';

// Agentlet daemon status (M4): the wire snapshot the L2 control plane
// surfaces about the single embedded agentlet it supervises. Browser-safe
// (zod-only) so L1's UI can consume it transitively through
// @huabu/shared without depending on the fastify-bound host package.
export { agentletStatusSchema } from './agentlet-status.js';
export type { AgentletStatus } from './agentlet-status.js';
