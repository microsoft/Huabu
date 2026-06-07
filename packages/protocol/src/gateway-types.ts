import type { AcpMessage } from './json-rpc.js'
import type { AgentHelloParams, AgentletHelloParams, LifecycleEvent, AgentSuspendedParams } from './messages.js'

// ─── Server Configuration ────────────────────────────────────────────────────

/** Options for constructing an AgentletServer instance */
export interface AgentletServerOptions {
  /**
   * Validate the token from the WebSocket upgrade.
   * Called for both agentlet/hello and agent/hello.
   * Throw an Error to reject the connection.
   *
   * @param token - The authentication token (from WS query param)
   * @param params - The hello params (AgentHelloParams or AgentletHelloParams)
   * @returns Optional metadata to attach to the connection
   */
  authenticate: (token: string, params: AgentHelloParams | AgentletHelloParams) => Promise<AuthResult>

  /** Called when a new agent session connects (not called for agentlet control connections) */
  onConnection?: (agent: AgentConnection) => void

  /** Called when a previously disconnected agent session reconnects (same sessionId) */
  onReconnection?: (agent: AgentConnection) => void

  /** Called when an agent session disconnects (network drop or graceful goodbye) */
  onDisconnection?: (agent: AgentConnection, reason: string) => void

  /** Called when an agentlet reports a session was suspended (idle timeout) */
  onSessionSuspended?: (params: AgentSuspendedParams, agentletSessionId: string) => void

  /** Max time (ms) to wait for hello after WebSocket opens. Default: 10000 */
  handshakeTimeout?: number

  /** Max messages buffered per connection for replay on reconnection. Default: 100 */
  outboundBufferLimit?: number

  /**
   * Persistence directory (required). The server creates:
   * - <storeDir>/sessions.db — session metadata (SQLite)
   * - <storeDir>/events/    — per-session event logs (JSONL)
   */
  storeDir: string
}

/** Result returned by the authenticate callback */
export interface AuthResult {
  /**
   * Application-specific metadata (user info, project, permissions, etc.)
   * Stored on AgentConnection.metadata and available to host app.
   */
  metadata?: Record<string, unknown>
}

// ─── AgentConnection ──────────────────────────────────────────────────────────

/** Represents a connected (or recently-disconnected) agent in the server registry */
export interface AgentConnection {
  /** Connection identifier — sessionId for agent-sessions, agentletId for agentlets */
  readonly sessionId: string

  /** Parent agentlet ID (equals sessionId for agentlet connections) */
  readonly agentletId: string

  /** Connection role */
  readonly role: 'agentlet' | 'agent-session'

  /** Application-specific metadata (from AuthResult.metadata) */
  readonly metadata: Record<string, unknown>

  /** Current connection state */
  readonly status: 'connected' | 'disconnected'

  /** When this connection was first established */
  readonly connectedAt: Date

  /** Send an ACP message to the agent */
  send(message: AcpMessage): void

  /** Register handler for ACP messages from the agent */
  onMessage(handler: (message: AcpMessage) => void): void

  /** Register handler for lifecycle events */
  onLifecycle(handler: (event: LifecycleEvent) => void): void

  /** Request graceful disconnect (sends server/shutdown to agentlet) */
  disconnect(reason?: string): void
}
