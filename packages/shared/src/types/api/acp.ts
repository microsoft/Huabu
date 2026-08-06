/**
 * ACP (External-agent) API wire types.
 *
 * Sediment connects to external agent CLIs (Copilot / Claude / Gemini /
 * custom) via agentlet's **daemon mode**. The server forks an in-process
 * agentlet daemon at boot; users configure long-lived **agent profiles**
 * (cli + cwd + flags) and the daemon spawns agent processes on demand.
 *
 * There is one daemon per Sediment instance and the user never has to
 * pair it manually — it is invisible infrastructure surfaced only when
 * something has gone wrong (see `AcpAgentletStatus.lastError`).
 *
 * Per docs/architecture/api-design.md, zod schemas defined here are server-side
 * truth; the web bundle imports the inferred TS types only
 * (`import type { ... } from '@sediment/shared'`) to keep zod out of
 * the production browser bundle.
 */

import { agentletStatusSchema } from '@agenetes/protocol';
import { z } from 'zod';

import {
  ZAcpModelInfo,
  ZAcpSessionConfigOption,
  ZAcpSessionMode,
} from './acp-tool.js';
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

/** A user-configured external agent the daemon spawns on demand. */
export interface AcpAgentProfile {
  /** Stable uuid; never reused after delete. */
  id: string;
  /** User-edited display name (e.g. "Copilot @ project-x"). */
  displayName: string;
  /**
   * CLI id from {@link AcpAgentCliInfo.id} (`copilot` / `claude` / …),
   * `'custom'` when {@link command} was entered manually,
   * or `'agent-team'` when this profile is backed by an Agent Team package.
   */
  cliId: string;
  /** Full command line passed to the daemon. Absent for agent-team profiles. */
  command?: string;
  /** Absolute working directory on the daemon's host. Absent for agent-team profiles. */
  cwd?: string;
  /** Whether the daemon should auto-restart the agent on crash. */
  autoRestart: boolean;
  /**
   * Agent Team reference. When present, the daemon resolves command/cwd
   * from the agent-team manifest instead of using stored command/cwd.
   */
  agentTeam?: {
    /** Absolute path to the agent-team package folder (containing agentlet.yaml). */
    agentDir: string;
    /** Target harness. If omitted, uses the first from manifest supported_harnesses. */
    harness?: string;
  };
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
}

// ─── Agentlet status (one agentlet per Sediment) ──────────────────────
//
// The server forks an idle agentlet as a child process at boot and
// supervises it with exponential-backoff restart. Status is exposed
// only so the UI can render a single troubleshooting affordance when
// the supervisor gives up; on the happy path the user never sees it.

/**
 * Status of the single agentlet known to this Sediment instance.
 *
 * Canonically defined as `AgentletStatus` in `@agenetes/protocol`
 * (the L2 control-plane wire contract); re-exported here under the
 * historical Sediment name so existing L1 / browser consumers are
 * unaffected. Browser-safe (the definition is zod-only in protocol).
 */
export type AcpAgentletStatus = AgentletStatus;

/** @deprecated Use {@link AcpAgentletStatus} instead. */
export type AcpDaemonStatus = AcpAgentletStatus;

// ─── Profile + agentlet HTTP wire ─────────────────────────────────────

/** Response body for `GET /api/acp/profiles`. */
export interface AcpProfilesListResponse {
  profiles: AgentProfileView[];
  selectableProfileIds: string[];
  agentlet: AcpAgentletStatus;
}

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
// The server probes the host for known ACP-capable agent binaries
// (`copilot`, `gemini` natively; `claude-agent-acp` and `codex-acp` for
// Claude / Codex, which have no native ACP mode and are driven through
// their ACP adapters) and reports their installation state. Powers the
// agent dropdown in the Profile Editor — picking an installed agent
// pre-fills `command` for the new profile.
//
// This endpoint is loopback-only — it shells out to discover host
// binaries and must never be reachable from a remote browser.

/** Definition + detection result for one known external agent CLI. */
export interface AcpAgentCliInfo {
  /** Stable short id used by the UI (`copilot` / `claude` / `gemini`). */
  id: string;
  /** Display name shown in the Profile Editor. */
  displayName: string;
  /**
   * Binary name the user must install and that the daemon launches
   * (`copilot`, or `claude-agent-acp` for the Claude ACP adapter).
   */
  binary: string;
  /** Args after the binary to enter ACP mode (typically `['--acp']`). */
  acpArgs: string[];
  /**
   * Official CLI arguments that enable full tool auto-approval, or `null`
   * when the agent requires another mechanism such as an environment
   * variable or an ACP session mode. `position` preserves CLIs where global
   * options must precede an ACP subcommand.
   */
  autoApprove: {
    args: string[];
    position: 'before-acp' | 'after-acp';
  } | null;
  /**
   * `<binary> --version` first line (trimmed). May be an empty string
   * when the binary is on PATH but the version probe failed (network
   * tool, slow startup, etc.) — `installed` is still `true`.
   */
  version?: string;
  /** True iff `binary` was resolved on the host's PATH. */
  installed: boolean;
  /** One-line `npm install -g …` hint used in error / help text. */
  installHint: string;
}

/** Response body for `GET /api/acp/agent-cli`. */
export interface AcpAgentCliListResponse {
  /**
   * Complete trusted agent catalogue in canonical display order, including
   * entries with `installed === false`.
   */
  agents: AcpAgentCliInfo[];
}

// ─── Thread → agent binding ────────────────────────────────────────────
//
// Each chat thread is permanently bound to a single agent for its entire
// lifetime. The binding is a stable reference to either the built-in
// agent OR a user-configured external profile.

/**
 * Internal binding — chat thread talks to Sediment's built-in agent.
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
// text body. Hence Sediment forwards the typed slash text verbatim
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
 * Request body for `POST /api/acp/threads/:threadId/session` — eagerly
 * open (or reuse) the per-thread ACP session so the web client can pull
 * slash commands BEFORE the user submits their first prompt.
 *
 * The server resolves `profileId` to a live agentlet agent (spawning
 * one on the daemon if needed) before opening the session.
 */
export interface EnsureAcpSessionRequest {
  /** Sediment canvasId scoping the session sandbox. Optional only for the no-canvas edge case. */
  canvasId?: string;
  /** The user-configured profile this thread is bound to. */
  profileId: string;
  /**
   * Optional `cwd` override for `session/new`. When omitted the server
   * uses the profile's `cwd`. (Reserved for future per-thread cwd
   * pinning; current UI does not expose it.)
   */
  cwd?: string;
}

/** Response body for `POST /api/acp/threads/:threadId/session`. */
export interface EnsureAcpSessionResponse {
  /** ACP session id (opaque to the client). */
  sessionId: string;
  /**
   * Currently-cached slash commands for this session. May be empty
   * when the agent has not pushed its list yet — callers should
   * follow up with `GET /api/acp/threads/:threadId/commands` after a
   * short delay to catch a late push.
   */
  availableCommands: AvailableCommand[];
  /** Epoch ms when `availableCommands` was last refreshed. 0 if never. */
  updatedAt: number;
  /**
   * Snapshot of session-meta (modes / models / config options / info /
   * usage) the server has cached. Always present (defaults to empty
   * fields when the agent has not pushed anything). Web UI uses this
   * to seed selector dropdowns before any SSE frame arrives.
   */
  sessionMeta: AcpSessionMetaSnapshot;
}

/** Query for `GET /api/acp/threads/:threadId/commands`. */
export interface AcpThreadCommandsQuery {
  /** Canvas containing the persisted workload placement. */
  canvasId?: string;
}

/** Response body for `GET /api/acp/threads/:threadId/commands`. */
export interface AcpThreadCommandsResponse {
  sessionId: string;
  availableCommands: AvailableCommand[];
  /** Epoch ms when `availableCommands` was last refreshed. 0 if never. */
  updatedAt: number;
  /**
   * Snapshot of session-meta (modes / models / config options / info /
   * usage). Same shape as on {@link EnsureAcpSessionResponse}.
   */
  sessionMeta: AcpSessionMetaSnapshot;
}

/**
 * Response body for `GET /api/acp/threads/:threadId/cached-meta`.
 *
 * Read-only, **never spawns** an agent. Returns whatever snapshot the
 * server has on disk (from a prior live session) plus, if a live
 * session is still in the in-process registry, the freshest in-memory
 * state on top.
 *
 * Cache miss (no persisted record and no live entry) returns an empty
 * snapshot with `updatedAt === 0`. The UI uses this to seed the
 * selector dropdowns and badge "optimistic green" state before any
 * real ensure-session call is made — i.e. opening a thread no longer
 * needs to spawn an agentlet just to populate the toolbar.
 */
export interface AcpThreadCachedMetaResponse {
  sessionMeta: AcpSessionMetaSnapshot;
}

/**
 * Categorical error codes returned in `ApiErrorBody.code` from
 * `POST /api/acp/threads/:threadId/session` on 503.
 *
 * Mirrors the server's `AcpEnsureErrorCode` (in
 * `apps/server/src/modules/agent/acp/errors.ts`). The web client
 * switches on this to render a remediation-specific badge tooltip
 * and CTA (e.g. "Restart worker", "Re-create profile").
 *
 * Wire-stable: renaming or removing a code is a breaking change for
 * any out-of-tree client. Adding a new code is safe (clients fall
 * back to the generic message).
 *
 *   • `profile_missing` — bound profile no longer exists.
 *   • `bridge_not_mounted` — embedded agentlet bridge still booting.
 *   • `worker_not_ready` — agentlet daemon worker never came online.
 *   • `placement_unavailable` — the explicitly targeted agentlet is offline.
 *   • `session_resume_unavailable` — persisted native session is gone.
 *   • `spawn_failed` — daemon rejected the spawn RPC (bad recipe).
 *   • `connect_timeout` — agent process started but never opened WS
 *     (most often: interactive auth needed, e.g. expired Copilot
 *     OAuth, or immediate crash).
 *   • `internal` — uncategorised throw; treat as a bug.
 */
export type AcpEnsureErrorCode =
  | 'profile_missing'
  | 'bridge_not_mounted'
  | 'worker_not_ready'
  | 'placement_unavailable'
  | 'session_resume_unavailable'
  | 'spawn_failed'
  | 'connect_timeout'
  | 'internal';

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
export interface SetAcpSessionModeRequest {
  modeId: string;
  /**
   * Optional spawn context. The selector dropdowns are populated from
   * a no-spawn cached-meta snapshot, so the user can switch mode
   * BEFORE any live session exists. When set, the server opens (or
   * reuses) the session on-demand before applying the RPC instead of
   * failing with `session_not_found`. Omit only when the caller knows
   * a live session already exists.
   */
  profileId?: string;
  canvasId?: string;
  cwd?: string;
}

/** Response body for `POST /api/acp/threads/:threadId/mode`. */
export interface SetAcpSessionModeResponse {
  ok: true;
  /** Echo back the freshly-set mode id; agent confirms via SSE separately. */
  modeId: string;
}

/**
 * Request body for `POST /api/acp/threads/:threadId/model`.
 * Switches the session's currently-active model.
 */
export interface SetAcpSessionModelRequest {
  modelId: string;
  /** Optional spawn context — see {@link SetAcpSessionModeRequest}. */
  profileId?: string;
  canvasId?: string;
  cwd?: string;
}

/** Response body for `POST /api/acp/threads/:threadId/model`. */
export interface SetAcpSessionModelResponse {
  ok: true;
  modelId: string;
}

/**
 * Request body for `POST /api/acp/threads/:threadId/config-option`.
 *
 * `value` follows the ACP `SessionConfigValueId` shape:
 *   • `string`  for `select` options (the chosen `id`)
 *   • `boolean` for `boolean` options
 */
export interface SetAcpSessionConfigOptionRequest {
  configOptionId: string;
  value: string | boolean;
  /** Optional spawn context — see {@link SetAcpSessionModeRequest}. */
  profileId?: string;
  canvasId?: string;
  cwd?: string;
}

/** Response body for `POST /api/acp/threads/:threadId/config-option`. */
export interface SetAcpSessionConfigOptionResponse {
  ok: true;
  configOptionId: string;
  value: string | boolean;
}

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

/** Schema mirror of {@link EnsureAcpSessionRequest}. */
export const ensureAcpSessionRequestSchema = z.object({
  canvasId: z.string().min(1).optional(),
  profileId: z.string().min(1),
  cwd: z.string().min(1).optional(),
}) satisfies z.ZodType<EnsureAcpSessionRequest>;

/** Schema mirror of {@link EnsureAcpSessionResponse}. */
export const ensureAcpSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  availableCommands: z.array(availableCommandSchema),
  updatedAt: z.number().int().nonnegative(),
  sessionMeta: acpSessionMetaSnapshotSchema,
}) satisfies z.ZodType<EnsureAcpSessionResponse>;

/** Schema mirror of {@link AcpThreadCommandsQuery}. */
export const acpThreadCommandsQuerySchema = z.object({
  canvasId: z.string().min(1).optional(),
}) satisfies z.ZodType<AcpThreadCommandsQuery>;

/** Schema mirror of {@link AcpThreadCommandsResponse}. */
export const acpThreadCommandsResponseSchema = z.object({
  sessionId: z.string().min(1),
  availableCommands: z.array(availableCommandSchema),
  updatedAt: z.number().int().nonnegative(),
  sessionMeta: acpSessionMetaSnapshotSchema,
}) satisfies z.ZodType<AcpThreadCommandsResponse>;

/** Schema mirror of {@link AcpThreadCachedMetaResponse}. */
export const acpThreadCachedMetaResponseSchema = z.object({
  sessionMeta: acpSessionMetaSnapshotSchema,
}) satisfies z.ZodType<AcpThreadCachedMetaResponse>;

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

/** Schema mirror of {@link SetAcpSessionModeRequest}. */
export const setAcpSessionModeRequestSchema = z.object({
  modeId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  canvasId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
}) satisfies z.ZodType<SetAcpSessionModeRequest>;

/** Schema mirror of {@link SetAcpSessionModeResponse}. */
export const setAcpSessionModeResponseSchema = z.object({
  ok: z.literal(true),
  modeId: z.string().min(1),
}) satisfies z.ZodType<SetAcpSessionModeResponse>;

/** Schema mirror of {@link SetAcpSessionModelRequest}. */
export const setAcpSessionModelRequestSchema = z.object({
  modelId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  canvasId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
}) satisfies z.ZodType<SetAcpSessionModelRequest>;

/** Schema mirror of {@link SetAcpSessionModelResponse}. */
export const setAcpSessionModelResponseSchema = z.object({
  ok: z.literal(true),
  modelId: z.string().min(1),
}) satisfies z.ZodType<SetAcpSessionModelResponse>;

/** Schema mirror of {@link SetAcpSessionConfigOptionRequest}. */
export const setAcpSessionConfigOptionRequestSchema = z.object({
  configOptionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
  profileId: z.string().min(1).optional(),
  canvasId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
}) satisfies z.ZodType<SetAcpSessionConfigOptionRequest>;

/** Schema mirror of {@link SetAcpSessionConfigOptionResponse}. */
export const setAcpSessionConfigOptionResponseSchema = z.object({
  ok: z.literal(true),
  configOptionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
}) satisfies z.ZodType<SetAcpSessionConfigOptionResponse>;

// ─── Agent-profile / daemon schemas ────────────────────────────────────

/** Zod schema for the agentTeam sub-object. */
const agentTeamFieldSchema = z.object({
  agentDir: z.string().min(1),
  harness: z.string().min(1).optional(),
});

/** Schema mirror of {@link AcpAgentProfile}. */
export const acpAgentProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  cliId: z.string().min(1),
  command: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  autoRestart: z.boolean(),
  agentTeam: agentTeamFieldSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<AcpAgentProfile>;

/** Schema mirror of {@link AcpAgentletStatus}; re-exported from `@agenetes/protocol`. */
export const acpAgentletStatusSchema = agentletStatusSchema;

/** @deprecated Use {@link acpAgentletStatusSchema} instead. */
export const acpDaemonStatusSchema = acpAgentletStatusSchema;

/** Schema mirror of {@link AcpProfilesListResponse}. */
export const acpProfilesListResponseSchema = z.object({
  profiles: z.array(agentProfileSchema),
  selectableProfileIds: z.array(z.string().min(1)),
  agentlet: acpAgentletStatusSchema,
}) satisfies z.ZodType<AcpProfilesListResponse>;

// {@link AcpProfileMutationResponse}, {@link AcpAgentletStatusResponse} and
// {@link AcpAgentletRestartResponse} are type aliases; reuse
// `agentProfileSchema` / `acpAgentletStatusSchema` directly
// at the route boundary.
