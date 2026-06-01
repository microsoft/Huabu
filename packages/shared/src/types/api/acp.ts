/**
 * ACP (External-agent bridge) API wire types.
 *
 * Read-only visibility surface for the agentlet bridge. Server
 * enumerates currently-connected external agents; the chat UI shows a
 * status indicator and feeds the agent picker in the ChatPanel.
 *
 * Schemas live here (and not in `agent.ts`) because ACP is a separate
 * subsystem that may grow its own endpoints (`/api/acp/agents`,
 * eventually `/api/acp/events` SSE). Keeping them isolated lets us
 * delete the file cleanly if ACP is ever removed.
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

/**
 * One connected ACP agent as exposed to the web client.
 *
 * `alias` is the short, human-readable identifier used in chat (e.g. `claude`).
 * `agentId` is the agentlet-issued unique key (`host:cmd:cwd:uuid`) and is
 * what the server uses internally to dispatch `session/prompt` to the right
 * `AgentConnection`. The client should treat `agentId` as opaque.
 */
export interface AcpAgentSummary {
  /** agentlet's globally-unique connection id (opaque to the client). */
  agentId: string;
  /** Short display name derived from the agent command (e.g. `claude`). */
  alias: string;
  /** Full command line the user launched (e.g. `claude --acp`). */
  command: string;
  /** OS process id of the agent on the user's machine. */
  pid: number;
  /** Machine info reported via bridge/hello, when provided. */
  hostname?: string;
  platform?: string;
  /** ISO timestamp of the first successful connection. */
  connectedAt: string;
}

/** Response body for `GET /api/acp/agents`. */
export interface AcpAgentsResponse {
  /** May be empty — either no agents connected, or ACP bridge disabled. */
  agents: AcpAgentSummary[];
  /**
   * `false` when the ACP bridge is disabled in the server config
   * (`data/acp-config.json` `enabled: false`). Used by the client to
   * suppress agent-related UI vs. showing "no agents connected yet"
   * guidance.
   *
   * NOTE: even when `false`, the WS endpoint at `/api/acp/agent` is
   * always mounted — the security boundary is the in-memory token store,
   * which stays empty while disabled. Toggling `enabled` is a runtime
   * action via `PUT /api/acp/config` and does not require a server
   * restart.
   */
  enabled: boolean;
}

// ─── Bridge enable / token configuration ───────────────────────────────
//
// Persisted to `data/acp-config.json` and exposed via
// `GET/PUT /api/acp/config`. The Settings UI is the sole authority for
// this config — there is no `.env`-based override.

/** Currently-effective ACP bridge configuration. */
export interface AcpConfig {
  /** Whether external ACP agents are allowed to connect right now. */
  enabled: boolean;
  /**
   * Shared secret the local `agentlet` CLI must present in `bridge/hello`.
   * Generated automatically on first enable; rotatable via PUT. The
   * bundled `bin/agentlet` wrapper reads this value from the JSON file
   * directly so users don't need to copy/paste it anywhere.
   */
  token: string;
  /**
   * Where the active config came from:
   *   - `file`    — `data/acp-config.json` was read.
   *   - `default` — no file yet; config is the bootstrap default
   *                 (`enabled: false`, `token: ''`).
   */
  source: 'file' | 'default';
}

/** Body for `PUT /api/acp/config`. */
export const acpConfigUpdateSchema = z.object({
  /** Flip the bridge on or off. */
  enabled: z.boolean(),
  /**
   * When enabling: generate a fresh random token even if one already
   * exists (rotation). When disabling: ignored. Defaults to `false`
   * — first-time enable auto-generates a token only if none is set yet.
   */
  regenerateToken: z.boolean().optional(),
});
export type AcpConfigUpdate = z.infer<typeof acpConfigUpdateSchema>;

// ─── Thread → agent binding ────────────────────────────────────────────
//
// 1 chat thread is permanently bound to a single agent for its entire
// lifetime

/**
 * Internal binding — chat thread talks to Huabu's built-in agent.
 * Default for every newly-created thread.
 */
export interface AgentBindingInternal {
  kind: 'internal';
}

/**
 * External binding — chat thread is bound to a specific ACP-connected agent.
 * `alias` is the short name shown in the UI. `agentletAgentId` is the
 * opaque agentlet connection key that the server uses to dispatch
 * `session/prompt` (matches `AcpAgentSummary.agentId`).
 *
 * Persisted across page reloads via the chat store; cleared when the
 * thread is reset (`clearMessages`).
 */
export interface AgentBindingExternal {
  kind: 'external';
  alias: string;
  agentletAgentId: string;
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
 */
export interface EnsureAcpSessionRequest {
  /** Sediment canvasId scoping the session sandbox. Optional only for the no-canvas edge case. */
  canvasId?: string;
  /** Opaque agentlet connection id (matches `AcpAgentSummary.agentId`). */
  agentletAgentId: string;
  /** Short display alias (matches `AcpAgentSummary.alias`). */
  alias: string;
  /**
   * Optional `cwd` for `session/new`. When omitted the server sends
   * the `'/'` sentinel and the agentlet relay substitutes its own
   * `process.cwd()`. See service.ts for the full rule.
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
  agentletAgentId: z.string().min(1),
  alias: z.string().min(1),
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
