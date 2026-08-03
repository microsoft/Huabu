// The `AgentMetadata` contract — the driver-agnostic *snapshot* of an
// agent's selectable configuration + usage surface. See
// docs/proposals/layered-architecture.md §5 / M5.5 (Store 2).
//
// This is the STATE side of the control plane, the companion of two
// contracts this package already owns:
//   - the *mutation* vocabulary `ControlMsg` (`set_mode` / `set_model` /
//     `set_config_option`) ACTS ON this state, and
//   - the incremental `AgentStreamEvent` `*_update` frames
//     (`session_mode_update` / `config_options_update` /
//     `session_info_update` / `session_usage_update`) are the deltas that
//     FOLD INTO it.
// Naming the folded snapshot here closes a consistency gap: the mutation
// vocabulary and the capability descriptor (`AgentCapabilities`) were
// already protocol concepts, so the state they act on belongs here too.
//
// Modelled exactly like `AgentStreamEvent`: a thin, driver-agnostic shell
// whose ACP-shaped fields reference the Agent Client Protocol SDK's own
// zod so the shapes cannot drift from the standard. Every field is
// optional — an empty snapshot (a fresh session that has emitted no meta
// yet) is valid.
//
// Note on coverage vs the event union: `AgentStreamEvent` has no
// models-update or commands-update frame today (models arrive on the ACP
// `session/new` response, commands via the `available_commands_update`
// notification), but a *snapshot* must carry them, so they appear here.
// Whether to add matching push events is deferred to M6's `notifications()`
// and does not widen the event vocabulary now.

import {
  zAvailableCommand as ZAcpAvailableCommand,
  zCost as ZAcpCost,
  zModelId as ZAcpModelId,
  zModelInfo as ZAcpModelInfo,
  zSessionConfigOption as ZAcpSessionConfigOption,
  zSessionMode as ZAcpSessionMode,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { z } from 'zod';

/**
 * Title / activity snapshot (folds `session_info_update`). Both fields are
 * nullable per ACP spec; `null` means "explicitly cleared".
 */
const agentSessionInfoSchema = z.object({
  title: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/**
 * Running token / cost budget snapshot (folds `session_usage_update`).
 */
const agentUsageSchema = z.object({
  used: z.number(),
  size: z.number(),
  cost: ZAcpCost.nullable(),
});

/**
 * Explicit user selections, keyed by config-option id (`mode`, `model`,
 * and any agent-defined id such as `allow_all`).
 *
 * Separate from the agent-reported `current*` / `configOptions[].currentValue`
 * fields on purpose: several agents (Copilot CLI among them) implement those
 * as PROCESS-GLOBAL user settings and broadcast the same value to every live
 * session, so they answer "what did the user last pick anywhere", not "what
 * did the user pick for this thread". This map is written only by an explicit
 * `ControlMsg` set-RPC and is therefore the authoritative per-thread intent.
 */
const agentSelectionsSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean()]),
);

/**
 * The driver-neutral agent-metadata snapshot: the current, folded value of
 * every selectable / usage surface an agent runtime exposes. A driver
 * supplies a translator mapping its native meta into this shape (the ACP
 * driver's `handleSessionMetaUpdate` becomes that translator, M5.5/A3); it
 * is persisted on `AgentPersistentState` behind the `ThreadStore` port and
 * consumed uniformly by L1 (e.g. the profile-schema cache).
 *
 * All fields optional: absent ⇒ the agent has not reported that surface.
 */
export const agentMetadataSchema = z.object({
  /** Full mode catalogue (folds `session_mode_update.availableModes`). */
  availableModes: z.array(ZAcpSessionMode).optional(),
  /** Currently-active mode id; `null` ⇒ explicitly none. */
  currentModeId: z.string().nullish(),
  /** Full model catalogue (no stream event — from `session/new`). */
  availableModels: z.array(ZAcpModelInfo).optional(),
  /** Currently-active model id; `null` ⇒ explicitly none. */
  currentModelId: ZAcpModelId.nullish(),
  /** Slash-command catalogue (from `available_commands_update`). */
  availableCommands: z.array(ZAcpAvailableCommand).optional(),
  /** Epoch ms the command catalogue was last refreshed. */
  commandsUpdatedAt: z.number().optional(),
  /** Selectable config options (folds `config_options_update`). */
  configOptions: z.array(ZAcpSessionConfigOption).optional(),
  /** Title / activity snapshot; `null` ⇒ explicitly cleared. */
  sessionInfo: agentSessionInfoSchema.nullish(),
  /** Token / cost budget; `null` ⇒ explicitly cleared. */
  usage: agentUsageSchema.nullish(),
  /** Explicit per-thread user selections (see {@link agentSelectionsSchema}). */
  selections: agentSelectionsSchema.optional(),
  /** Epoch ms the selection map was last written by a set-RPC. */
  selectionsUpdatedAt: z.number().optional(),
  /** Epoch ms of the last meta update folded into this snapshot. */
  metaUpdatedAt: z.number().optional(),
});

/** The `AgentMetadata` snapshot type, derived from the wire schema. */
export type AgentMetadata = z.infer<typeof agentMetadataSchema>;
