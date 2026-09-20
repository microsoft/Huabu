// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP (External-agent) API wire types.
 *
 * Huabu connects to external agent CLIs (Copilot / Claude / Gemini /
 * custom) via agentlet's **daemon mode**. The server forks an in-process
 * agentlet daemon at boot; users configure long-lived **agent profiles**
 * (cli + cwd + flags) and the daemon spawns agent processes on demand.
 *
 * There is one daemon per Huabu instance and the user never has to
 * pair it manually — it is invisible infrastructure surfaced only when
 * something has gone wrong (see `AcpAgentletStatus.lastError`).
 *
 * Per docs/architecture/api-design.md, zod schemas defined here are server-side
 * truth; the web bundle imports the inferred TS types only
 * (`import type { ... } from '@huabu/shared'`) to keep zod out of
 * the production browser bundle.
 */

import { agentletStatusSchema } from '@agenetes/protocol';
import { z } from 'zod';

import {
  ZAcpModelInfo,
  ZAcpSessionConfigOption,
  ZAcpSessionMode,
} from './acp-tool.js';
import { agentDefaultsSchema } from './agent-defaults.js';
import { agentProfileSchema } from './agent-profile.js';

import type { AgentProfileView } from './agent-profile.js';
import type {
  AcpCost,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
} from '../agent/acp-tool.js';
import type { AgentletStatus } from '@agenetes/protocol';

// ─── Global external-agent runtime config ─────────────────────────────

export const externalAgentIdleTimeoutSecsSchema = z.union([
  z.literal(0),
  z.number().int().min(60).max(86_400).multipleOf(60),
]);

export const externalAgentRuntimeConfigSchema = z.object({
  idleTimeoutSecs: externalAgentIdleTimeoutSecsSchema,
});

export type ExternalAgentRuntimeConfig = z.infer<
  typeof externalAgentRuntimeConfigSchema
>;

// ─── Agent profiles (user-configured spawn recipes) ────────────────────
//
// A profile is a stable, user-edited record describing how to spawn one
// external agent process: which CLI to run, in which working directory,
// with which env / flags. Profiles are the surface the user picks from
// in the chat panel; the actual agentlet process is spawned by the
// daemon on demand and may be torn down between turns.

/** Legacy command Profile, retained only for read-only migration. */
export type AcpAgentProfile = z.infer<typeof acpAgentProfileSchema>;

// ─── Agentlet status (one agentlet per Huabu) ──────────────────────
//
// The server forks an idle agentlet as a child process at boot and
// supervises it with exponential-backoff restart. Status is exposed
// only so the UI can render a single troubleshooting affordance when
// the supervisor gives up; on the happy path the user never sees it.

/**
 * Status of the single agentlet known to this Huabu instance.
 *
 * Canonically defined as `AgentletStatus` in `@agenetes/protocol`
 * (the L2 control-plane wire contract); re-exported here under the
 * historical Huabu name so existing L1 / browser consumers are
 * unaffected. Browser-safe (the definition is zod-only in protocol).
 */
export type AcpAgentletStatus = AgentletStatus;

/** @deprecated Use {@link AcpAgentletStatus} instead. */
export type AcpDaemonStatus = AcpAgentletStatus;

// ─── Profile + agentlet HTTP wire ─────────────────────────────────────

/** Response body for `GET /api/acp/profiles`. */
export type AcpProfilesListResponse = z.infer<
  typeof acpProfilesListResponseSchema
>;

/** Response body for `POST` / `PATCH` /api/acp/profiles[/:id]. */
export type AcpProfileMutationResponse = AgentProfileView;

/** Response body for `GET /api/acp/agentlet`. */
export type AcpAgentletStatusResponse = AcpAgentletStatus;

/** @deprecated Use {@link AcpAgentletStatusResponse} instead. */
export type AcpDaemonStatusResponse = AcpAgentletStatusResponse;

/**
 * Response body for `POST /api/acp/agentlet/restart`.
 *
 * Empty request body. The reply is the post-restart snapshot — which
 * may still be `online: false` if the restart is asynchronous; the UI
 * should re-poll `/api/acp/agentlet` shortly after.
 */
export type AcpAgentletRestartResponse = AcpAgentletStatus;

/** @deprecated Use {@link AcpAgentletRestartResponse} instead. */
export type AcpDaemonRestartResponse = AcpAgentletRestartResponse;

// ─── Local agent CLI detection ────────────────────────────────────────
//
// The server proxies the daemon's detection result from the local machine.
// Picking a supported installed agent submits a structured harness launch.
//
// This endpoint is owner-only and never probes the Huabu Server's PATH.

/** Daemon-owned detection result for one external agent CLI. */
export const acpAgentCliInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  binary: z.string().min(1),
  acpArgs: z.array(z.string()),
  /** `position` preserves CLIs whose global options precede ACP arguments. */
  autoApprove: z
    .object({
      args: z.array(z.string()),
      position: z.enum(['before-acp', 'after-acp']),
    })
    .nullable(),
  version: z.string().optional(),
  installed: z.boolean(),
  installHint: z.string(),
  executablePath: z.string().optional(),
  workingDirPath: z.string().optional(),
  launchVersion: z.literal(1).optional(),
  capabilities: z
    .object({
      autoApprove: z.enum(['supported', 'unsupported', 'unknown']),
      modelOverride: z.enum(['supported', 'unsupported', 'unknown']),
      sessionPersistence: z.enum(['supported', 'unsupported', 'unknown']),
    })
    .optional(),
  diagnostics: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
});
export type AcpAgentCliInfo = z.infer<typeof acpAgentCliInfoSchema>;

/** Response body for `GET /api/acp/agent-cli`, including unavailable entries. */
export const acpAgentCliListResponseSchema = z.object({
  agents: z.array(acpAgentCliInfoSchema),
});
export type AcpAgentCliListResponse = z.infer<
  typeof acpAgentCliListResponseSchema
>;

// ─── Thread → agent binding ────────────────────────────────────────────
//
// Each chat thread is permanently bound to a single agent for its entire
// lifetime. The binding is a stable reference to either the built-in
// agent OR a user-configured external profile.

/**
 * Internal binding — chat thread talks to Huabu's built-in agent.
 * Default for every newly-created thread.
 */
export interface AgentBindingInternal {
  kind: 'internal';
}

/**
 * External binding — chat thread is bound to a user-configured ACP
 * profile. The server resolves `profileId` to a live agentlet agent
 * (spawning one via the daemon if needed) at request time; the actual
 * `agentletAgentId` is intentionally NOT part of the binding because
 * it changes across spawns.
 *
 * `alias` is a bind-time display fallback. Surfaces should prefer the current
 * Profile alias while the Profile still exists, then use this snapshot after
 * the Profile is deleted or otherwise unavailable.
 */
export interface AgentBindingExternal {
  kind: 'external';
  /** Bind-time display fallback used when the Profile is unavailable. */
  alias: string;
  /** The user-configured profile this thread is bound to. */
  profileId: string;
}

export type AgentBinding = AgentBindingInternal | AgentBindingExternal;

// ─── Slash commands (per ACP `available_commands_update`) ──────────────
//
// External agents may push a `session/update` notification with
// `sessionUpdate: 'available_commands_update'` carrying the full
// list of slash commands they currently expose. Per ACP v1:
//   - The list REPLACES (not merges with) any prior state for the
//     session.
//   - Push timing is uncontrolled; typically arrives shortly after
//     `session/new` resolves, but the spec offers no guarantee.
//   - There is no client→agent RPC to fetch commands; we cache the
//     latest push and serve it from the server.
//
// Slash commands themselves are NOT a separate RPC — the agent
// recognises `/<name> <args>` inline inside a normal `session/prompt`
// text body. Hence Huabu forwards the typed slash text verbatim
// (the preprocessor short-circuits to avoid LLM rewriting).

/**
 * One agent-defined slash command, mirroring ACP's `AvailableCommand`.
 */
export interface AvailableCommand {
  /** Identifier the user types after the leading `/` (e.g. `compact`). */
  name: string;
  /** Short one-line description shown in the typeahead. */
  description: string;
  /**
   * Optional input metadata. ACP currently defines only the
   * unstructured `{ hint: string }` form (free-text argument).
   * `null` is allowed because some agents emit it explicitly.
   */
  input?: { hint: string } | null;
}

/**
 * Response body for `GET /api/acp/threads/:threadId/cached-meta`.
 *
 * Read-only, **never spawns** an agent. Returns whatever snapshot the
 * server has on disk, the Profile capability observation, or the freshest
 * live state. It also carries the cached slash-command catalogue.
 *
 * Cache miss (no persisted record and no live entry) returns an empty
 * snapshot with `updatedAt === 0`. The UI uses this to seed the
 * selector dropdowns and slash menu without spawning an agentlet.
 */
export type AcpThreadCachedMetaResponse = z.infer<
  typeof acpThreadCachedMetaResponseSchema
>;

// ─── Session-meta snapshot & set-RPCs ──────────────────────────────────
//
// ACP exposes four kinds of mutable session metadata, surfaced to the
// UI as dropdown selectors:
//
//   • Available modes (`current_mode_update`) — Copilot uses this for
//     its "interactive / yolo / plan" mode picker.
//   • Available models (no dedicated update notification; only seeded
//     from the `session/new` / `session/load` response).
//   • Config options (`config_option_update`) — free-form key/value
//     knobs grouped by `category` (`mode` / `model` / `thought_level`
//     / `string`).
//   • Session info (`session_info_update`) and usage (`usage_update`)
//     — read-only display values.
//
// The set-RPCs (`session/setSessionMode`, `session/setSessionModel`,
// `session/setSessionConfigOption`) round-trip through the bridge to
// the agent. We surface them as small POST endpoints so the web bundle
// can stay schema-free.

/**
 * Server-cached snapshot of every session-meta field the agent has
 * pushed. Empty arrays / nulls when the agent has not provided a
 * value yet.
 */
export interface AcpSessionMetaSnapshot {
  /** Current `availableModes` list (cleared & replaced per update). */
  availableModes: AcpSessionMode[];
  /** Currently-active mode id, or `null` if the agent has not set one. */
  currentModeId: string | null;
  /** Catalogue of selectable models. */
  availableModels: AcpModelInfo[];
  /** Currently-active model id. */
  currentModelId: string | null;
  /** Free-form config knobs (most recent snapshot, replace-semantics). */
  configOptions: AcpSessionConfigOption[];
  /**
   * Explicit user selections for this thread, keyed by config-option id
   * (`mode` / `model` / agent-defined ids such as `allow_all`).
   *
   * Takes precedence over `currentModeId` / `currentModelId` /
   * `configOptions[].currentValue` when rendering: those carry the
   * AGENT's view, which for agents with process-global settings is the
   * value last picked in any session rather than in this one.
   */
  selections: Record<string, string | boolean>;
  /** Human-readable title + activity timestamp pushed by the agent. */
  sessionInfo: { title: string | null; updatedAt: string | null } | null;
  /** Token / cost budget snapshot. */
  usage: { used: number; size: number; cost: AcpCost | null } | null;
  /**
   * Epoch ms when ANY field of `sessionMeta` was last touched.
   * UI can use this to detect stale snapshots after reconnect.
   */
  updatedAt: number;
}

/**
 * Request body for `POST /api/acp/threads/:threadId/mode`.
 * Switches the session's currently-active mode.
 */
// ─── Permission decisions ──────────────────────────────────────────────
//
// Reply channel for a `permission_request` SSE event (see
// `AgentPermissionRequestEventData`). SSE is one-way server→client, so
// the user's approve/deny choice comes back over this POST. The server
// matches it to the suspended `session/request_permission` promise by
// `requestId` and resolves it (or treats a missing/duplicate id as a
// no-op when the request already timed out / was answered).

/**
 * Request body for `POST /api/acp/threads/:threadId/permission`.
 *
 * Exactly one of `optionId` (user picked an option) or `cancelled`
 * (user dismissed) is meaningful; if neither is set the server treats
 * it as a cancel.
 */
export interface AcpPermissionDecisionRequest {
  /** The `requestId` from the originating `permission_request` event. */
  requestId: string;
  /** ACP `optionId` the user selected. Omit to cancel. */
  optionId?: string;
  /** Explicit cancel (user dismissed the prompt). */
  cancelled?: boolean;
}

/** Response body for `POST /api/acp/threads/:threadId/permission`. */
export interface AcpPermissionDecisionResponse {
  /**
   * `true` when a suspended request matched `requestId` and was
   * resolved by this call; `false` when none matched (already answered,
   * timed out, or the session ended) — the client can safely ignore.
   */
  resolved: boolean;
}

// ─── Zod schemas (server-side only) ────────────────────────────────────
//
// Defined here per docs/architecture/api-design.md so every public HTTP boundary
// gets field-level validation via `safeParse`. The web bundle imports
// the TS types only.

/** Schema mirror of {@link AvailableCommand}. */
export const availableCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input: z.object({ hint: z.string() }).nullable().optional(),
}) satisfies z.ZodType<AvailableCommand>;

/**
 * Schema mirror of `AcpCost` — kept inline here (rather than re-exported
 * from `acp-tool.ts`) because the SDK names the cost-block schema
 * differently from the type and we want the api file to own the wire
 * shape for the snapshot.
 */
const acpCostSchema = z.object({
  amount: z.number(),
  currency: z.string(),
}) satisfies z.ZodType<AcpCost>;

/** Schema mirror of {@link AcpSessionMetaSnapshot}. */
export const acpSessionMetaSnapshotSchema = z.object({
  availableModes: z.array(
    ZAcpSessionMode as unknown as z.ZodType<AcpSessionMode>,
  ),
  currentModeId: z.string().min(1).nullable(),
  availableModels: z.array(ZAcpModelInfo as unknown as z.ZodType<AcpModelInfo>),
  currentModelId: z.string().min(1).nullable(),
  configOptions: z.array(
    ZAcpSessionConfigOption as unknown as z.ZodType<AcpSessionConfigOption>,
  ),
  selections: z.record(z.string(), z.union([z.string(), z.boolean()])),
  sessionInfo: z
    .object({
      title: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  usage: z
    .object({
      used: z.number(),
      size: z.number(),
      cost: acpCostSchema.nullable(),
    })
    .nullable(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<AcpSessionMetaSnapshot>;

export const acpThreadCachedMetaQuerySchema = z.object({
  canvasId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
});
export type AcpThreadCachedMetaQuery = z.infer<
  typeof acpThreadCachedMetaQuerySchema
>;

/** Schema mirror of {@link AcpThreadCachedMetaResponse}. */
export const acpThreadCachedMetaResponseSchema = z.object({
  source: z.enum(['thread', 'profile', 'none']),
  availableCommands: z.array(availableCommandSchema),
  commandsUpdatedAt: z.number().int().nonnegative(),
  sessionMeta: acpSessionMetaSnapshotSchema,
});

/** Schema mirror of {@link AcpPermissionDecisionRequest}. */
export const acpPermissionDecisionSchema = z.object({
  requestId: z.string().min(1),
  optionId: z.string().min(1).optional(),
  cancelled: z.literal(true).optional(),
}) satisfies z.ZodType<AcpPermissionDecisionRequest>;

/** Schema mirror of {@link AcpPermissionDecisionResponse}. */
export const acpPermissionDecisionResponseSchema = z.object({
  resolved: z.boolean(),
}) satisfies z.ZodType<AcpPermissionDecisionResponse>;

// ─── Session-meta set-RPCs (zod) ───────────────────────────────────────

const externalAgentInteractionTargetSchema = z.object({
  binding: z.object({
    kind: z.literal('external'),
    alias: z.string().min(1),
    profileId: z.string().min(1),
  }),
  canvasId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
});

export const setAcpSessionModeRequestSchema =
  externalAgentInteractionTargetSchema.extend({
    modeId: z.string().min(1),
  });
export type SetAcpSessionModeRequest = z.infer<
  typeof setAcpSessionModeRequestSchema
>;

export const setAcpSessionModeResponseSchema = z.object({
  ok: z.literal(true),
  modeId: z.string().min(1),
});
export type SetAcpSessionModeResponse = z.infer<
  typeof setAcpSessionModeResponseSchema
>;

export const setAcpSessionModelRequestSchema =
  externalAgentInteractionTargetSchema.extend({
    modelId: z.string().min(1),
  });
export type SetAcpSessionModelRequest = z.infer<
  typeof setAcpSessionModelRequestSchema
>;

export const setAcpSessionModelResponseSchema = z.object({
  ok: z.literal(true),
  modelId: z.string().min(1),
});
export type SetAcpSessionModelResponse = z.infer<
  typeof setAcpSessionModelResponseSchema
>;

export const setAcpSessionConfigOptionRequestSchema = z.object({
  ...externalAgentInteractionTargetSchema.shape,
  configOptionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
});
export type SetAcpSessionConfigOptionRequest = z.infer<
  typeof setAcpSessionConfigOptionRequestSchema
>;

export const setAcpSessionConfigOptionResponseSchema = z.object({
  ok: z.literal(true),
  configOptionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
});
export type SetAcpSessionConfigOptionResponse = z.infer<
  typeof setAcpSessionConfigOptionResponseSchema
>;

// ─── Agent-profile / daemon schemas ────────────────────────────────────

/** Legacy command Profile schema for read-only migration. */
export const acpAgentProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  cliId: z.string().min(1),
  command: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  autoRestart: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/** Schema mirror of {@link AcpAgentletStatus}; re-exported from `@agenetes/protocol`. */
export const acpAgentletStatusSchema = agentletStatusSchema;

/** @deprecated Use {@link acpAgentletStatusSchema} instead. */
export const acpDaemonStatusSchema = acpAgentletStatusSchema;

/** Schema mirror of {@link AcpProfilesListResponse}. */
export const acpProfilesListResponseSchema = z.object({
  profiles: z.array(agentProfileSchema),
  selectableProfileIds: z.array(z.string().min(1)),
  agentlet: acpAgentletStatusSchema,
  agentDefaults: agentDefaultsSchema.optional(),
});

// {@link AcpProfileMutationResponse}, {@link AcpAgentletStatusResponse} and
// {@link AcpAgentletRestartResponse} are type aliases; reuse
// `agentProfileSchema` / `acpAgentletStatusSchema` directly
// at the route boundary.
