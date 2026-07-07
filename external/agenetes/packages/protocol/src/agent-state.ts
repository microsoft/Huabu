// The `AgentStateSnapshot` contract — the driver-agnostic *durable state*
// Agenetes keeps for one thread. See docs/proposals/layered-architecture.md
// §5 / M5.5 and README I9.7 (the notification surface).
//
// It is deliberately a SINGLE, FULL snapshot type that plays three roles at
// once, so the fold lives in exactly one place and every consumer stays
// stateless (README I9.7):
//   - the `handle.onState` up-report payload (handle → instance),
//   - the `ThreadRecord.state` an instance persists verbatim (I9.4), and
//   - what L1 reads (it takes `.metadata`, ignores the opaque `.sessionId`).
//
// It carries exactly two fields, both optional (an empty snapshot — a fresh
// session that has reported nothing yet — is valid):
//   - `sessionId`: the low-level driver resume token (I4.3), opaque and
//     driver-defined (an ACP session id for `session/load` recovery; absent
//     for drivers that have no such concept). It is NOT special-cased — it
//     rides the same snapshot as generic opaque data and L1 never reads it.
//   - `metadata`: the folded, driver-agnostic `AgentMetadata` snapshot
//     (M5.5) — the selectable / usage surface L1 consumes.

import { sessionIdSchema } from './identity.js';
import { agentMetadataSchema } from './agent-metadata.js';
import { z } from 'zod';

/**
 * The driver-agnostic durable-state snapshot for one thread — the full
 * `{ sessionId?, metadata? }` value the handle up-reports, the instance
 * persists as `ThreadRecord.state`, and L1 reads `.metadata` from (README
 * I9.7). A full snapshot, never a per-field delta: downstream consumers
 * replace wholesale.
 */
export const agentStateSnapshotSchema = z.object({
  /** The opaque low-level driver resume token (I4.3); absent until minted. */
  sessionId: sessionIdSchema.optional(),
  /** The folded driver-agnostic metadata snapshot (M5.5); absent until reported. */
  metadata: agentMetadataSchema.optional(),
});

/** The `AgentStateSnapshot` type, derived from the wire schema. */
export type AgentStateSnapshot = z.infer<typeof agentStateSnapshotSchema>;
