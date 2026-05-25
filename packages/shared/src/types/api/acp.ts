/**
 * ACP (External-agent bridge) API wire types.
 *
 * Phase 2 / PR A — read-only visibility surface for the agentlet bridge.
 * Server enumerates currently-connected external agents; the chat UI shows
 * a status indicator and (later, PR B) feeds the `@`-autocomplete list.
 *
 * Schemas live here (and not in `agent.ts`) because ACP is a separate
 * subsystem that may grow its own endpoints (`/api/acp/agents`,
 * eventually `/api/acp/events` SSE). Keeping them isolated lets us
 * delete the file cleanly if ACP is ever removed.
 *
 * See docs/huabu-acp-client-plan.md §Phase 2 D1 for the alias
 * derivation rule and §Phase 2 PR breakdown.
 */

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
   * `false` when the server was started without `SEDIMENT_ENABLE_ACP=1`.
   * The client uses this to suppress the indicator entirely vs. showing
   * "no agents connected yet" guidance.
   */
  enabled: boolean;
}
