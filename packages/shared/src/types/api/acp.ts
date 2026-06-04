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
 * something has gone wrong (see `AcpDaemonStatus.lastError`).
 *
 * Per docs/api-design.md, zod schemas defined here are server-side
 * truth; the web bundle imports the inferred TS types only
 * (`import type { ... } from '@sediment/shared'`) to keep zod out of
 * the production browser bundle.
 */

import { z } from 'zod';

import {
  ZAcpModelInfo,
  ZAcpSessionConfigOption,
  ZAcpSessionMode,
} from './acp-tool.js';

import type {
  AcpCost,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
} from '../agent/acp-tool.js';

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
   * OR `'custom'` when {@link command} was entered manually.
   */
  cliId: string;
  /** Full command line passed to the daemon (e.g. `"copilot --acp --allow-all"`). */
  command: string;
  /** Absolute working directory on the daemon's host. */
  cwd: string;
  /** Whether the daemon should auto-restart the agent on crash. */
  autoRestart: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
}

/**
 * Live runtime state of a profile, joined from the daemon's view at
 * read time. Not persisted — recomputed on every list / mutation reply.
 */
export interface AcpAgentProfileRuntime {
  /** True iff there is a currently-spawned agent for this profile. */
  spawned: boolean;
  /**
   * agentlet's connection id for the currently-spawned agent, when
   * `spawned`. Opaque to the client.
   */
  agentletAgentId?: string;
  /** OS pid on the daemon's host, when `spawned`. */
  pid?: number;
}

/** A profile plus its current runtime state — the shape the UI consumes. */
export type AcpAgentProfileWithRuntime = AcpAgentProfile & {
  runtime: AcpAgentProfileRuntime;
};

// ─── Daemon status (one daemon per Sediment) ──────────────────────────
//
// The server forks the agentlet daemon as a child process at boot and
// supervises it with exponential-backoff restart. Status is exposed
// only so the UI can render a single troubleshooting affordance when
// the supervisor gives up; on the happy path the user never sees it.

/** Status of the single daemon known to this Sediment instance. */
export interface AcpDaemonStatus {
  /** True when a daemon is currently connected to the bridge. */
  online: boolean;
  /** Opaque daemon id when online. */
  daemonId?: string;
  /** Hostname reported via bridge/hello. */
  hostname?: string;
  /** Platform string (e.g. `'darwin'`, `'win32'`). */
  platform?: string;
  /** ISO timestamp of the most recent successful daemon connection. */
  connectedAt?: string;
  /**
   * Most recent supervisor error message when the daemon is offline.
   * Empty / undefined on the happy path.
   */
  lastError?: string;
  /**
   * Epoch ms of the next scheduled restart attempt while in backoff.
   * Undefined when not in backoff (either online or supervisor gave up).
   */
  nextRestartAt?: number;
}

// ─── Profile + daemon HTTP wire ───────────────────────────────────────

/** Response body for `GET /api/acp/profiles`. */
export interface AcpProfilesListResponse {
  profiles: AcpAgentProfileWithRuntime[];
  daemon: AcpDaemonStatus;
}

/** Request body for `POST /api/acp/profiles`. */
export interface AcpProfileCreateRequest {
  /** Optional — server fills in a sensible default when omitted. */
  displayName?: string;
  cliId: string;
  command: string;
  cwd: string;
  /** Default true. */
  autoRestart?: boolean;
}

/** Request body for `PATCH /api/acp/profiles/:id`. All fields optional. */
export interface AcpProfileUpdateRequest {
  displayName?: string;
  command?: string;
  cwd?: string;
  autoRestart?: boolean;
}

/** Response body for `POST` / `PATCH` /api/acp/profiles[/:id]. */
export type AcpProfileMutationResponse = AcpAgentProfileWithRuntime;

/** Response body for `GET /api/acp/daemon`. */
export type AcpDaemonStatusResponse = AcpDaemonStatus;

/**
 * Response body for `POST /api/acp/daemon/restart`.
 *
 * Empty request body. The reply is the post-restart snapshot — which
 * may still be `online: false` if the restart is asynchronous; the UI
 * should re-poll `/api/acp/daemon` shortly after.
 */
export type AcpDaemonRestartResponse = AcpDaemonStatus;

// ─── Local agent CLI detection ────────────────────────────────────────
//
// The server probes the host for known ACP-capable CLI binaries
// (`copilot`, `claude`, `gemini`) and reports the ones it found.
// Powers the CLI dropdown in the Profile Editor — picking a detected
// CLI pre-fills `command` for the new profile.
//
// This endpoint is loopback-only — it shells out to discover host
// binaries and must never be reachable from a remote browser.

/** Definition + detection result for one known external agent CLI. */
export interface AcpAgentCliInfo {
  /** Stable short id used by the UI (`copilot` / `claude` / `gemini`). */
  id: string;
  /** Display name shown in the Profile Editor. */
  displayName: string;
  /** Binary name the user must install (`copilot`). */
  binary: string;
  /** Args after the binary to enter ACP mode (typically `['--acp']`). */
  acpArgs: string[];
  /**
   * Auto-approve flag this agent supports, or `null` if none is
   * recognized. UI shows a toggle ONLY when this is non-null;
   * checked → flag appended to the launch command.
   */
  allowAllFlag: string | null;
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
   * Detected agent CLIs. Server filters out `installed === false`
   * entries by default; UI shows nothing for missing agents.
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
 * `alias` is a UI-only mirror of `profile.displayName` captured at
 * bind-time; it remains stable even if the profile is renamed later.
 */
export interface AgentBindingExternal {
  kind: 'external';
  /** Display label shown in the UI (mirror of `profile.displayName`). */
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
// Defined here per docs/api-design.md so every public HTTP boundary
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

/** Schema mirror of {@link AcpThreadCommandsResponse}. */
export const acpThreadCommandsResponseSchema = z.object({
  sessionId: z.string().min(1),
  availableCommands: z.array(availableCommandSchema),
  updatedAt: z.number().int().nonnegative(),
  sessionMeta: acpSessionMetaSnapshotSchema,
}) satisfies z.ZodType<AcpThreadCommandsResponse>;

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
}) satisfies z.ZodType<SetAcpSessionModeRequest>;

/** Schema mirror of {@link SetAcpSessionModeResponse}. */
export const setAcpSessionModeResponseSchema = z.object({
  ok: z.literal(true),
  modeId: z.string().min(1),
}) satisfies z.ZodType<SetAcpSessionModeResponse>;

/** Schema mirror of {@link SetAcpSessionModelRequest}. */
export const setAcpSessionModelRequestSchema = z.object({
  modelId: z.string().min(1),
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
}) satisfies z.ZodType<SetAcpSessionConfigOptionRequest>;

/** Schema mirror of {@link SetAcpSessionConfigOptionResponse}. */
export const setAcpSessionConfigOptionResponseSchema = z.object({
  ok: z.literal(true),
  configOptionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
}) satisfies z.ZodType<SetAcpSessionConfigOptionResponse>;

// ─── Agent-profile / daemon schemas ────────────────────────────────────

/** Schema mirror of {@link AcpAgentProfile}. */
export const acpAgentProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  cliId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  autoRestart: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<AcpAgentProfile>;

/** Schema mirror of {@link AcpAgentProfileRuntime}. */
export const acpAgentProfileRuntimeSchema = z.object({
  spawned: z.boolean(),
  agentletAgentId: z.string().min(1).optional(),
  pid: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<AcpAgentProfileRuntime>;

/** Schema mirror of {@link AcpAgentProfileWithRuntime}. */
export const acpAgentProfileWithRuntimeSchema = acpAgentProfileSchema.extend({
  runtime: acpAgentProfileRuntimeSchema,
}) satisfies z.ZodType<AcpAgentProfileWithRuntime>;

/** Schema mirror of {@link AcpDaemonStatus}. */
export const acpDaemonStatusSchema = z.object({
  online: z.boolean(),
  daemonId: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  connectedAt: z.string().min(1).optional(),
  lastError: z.string().optional(),
  nextRestartAt: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<AcpDaemonStatus>;

/** Schema mirror of {@link AcpProfilesListResponse}. */
export const acpProfilesListResponseSchema = z.object({
  profiles: z.array(acpAgentProfileWithRuntimeSchema),
  daemon: acpDaemonStatusSchema,
}) satisfies z.ZodType<AcpProfilesListResponse>;

/** Schema mirror of {@link AcpProfileCreateRequest}. */
export const acpProfileCreateRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  cliId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  autoRestart: z.boolean().optional(),
}) satisfies z.ZodType<AcpProfileCreateRequest>;

/** Schema mirror of {@link AcpProfileUpdateRequest}. */
export const acpProfileUpdateRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  autoRestart: z.boolean().optional(),
}) satisfies z.ZodType<AcpProfileUpdateRequest>;

// {@link AcpProfileMutationResponse}, {@link AcpDaemonStatusResponse} and
// {@link AcpDaemonRestartResponse} are type aliases; reuse
// `acpAgentProfileWithRuntimeSchema` / `acpDaemonStatusSchema` directly
// at the route boundary.
