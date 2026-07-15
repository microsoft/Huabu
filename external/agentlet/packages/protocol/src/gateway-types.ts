import type { AcpMessage } from './json-rpc.js'
import type { LifecycleEvent } from './messages.js'

/** Host-owned metadata associated with an authenticated connection. */
export interface AuthResult {
  /**
   * Application-specific metadata (user info, project, permissions, etc.)
   * Stored on AgentConnection.metadata and available to the host app.
   */
  metadata?: Record<string, unknown>
}

// ─── AgentConnection ──────────────────────────────────────────────────────────

/** Represents a connected (or recently-disconnected) agent in a Gateway registry. */
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
