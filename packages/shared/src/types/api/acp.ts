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
   * `false` when the server was started without `ENABLE_ACP=1`.
   * The client uses this to suppress the indicator entirely vs. showing
   * "no agents connected yet" guidance.
   */
  enabled: boolean;
}

// ─── Thread → agent binding ────────────────────────────────────────────
//
// 1 chat thread is permanently bound to a single agent for its entire
// lifetime. The binding is set via the ChatPanel's ModeSelector dropdown
// and travels with every agent request.

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
}

/** Response body for `GET /api/acp/threads/:threadId/commands`. */
export interface AcpThreadCommandsResponse {
  sessionId: string;
  availableCommands: AvailableCommand[];
  /** Epoch ms when `availableCommands` was last refreshed. 0 if never. */
  updatedAt: number;
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
}) satisfies z.ZodType<EnsureAcpSessionResponse>;

/** Schema mirror of {@link AcpThreadCommandsResponse}. */
export const acpThreadCommandsResponseSchema = z.object({
  sessionId: z.string().min(1),
  availableCommands: z.array(availableCommandSchema),
  updatedAt: z.number().int().nonnegative(),
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
