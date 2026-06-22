import type { AcpMessage, JsonRpcError } from './json-rpc.js'

// ─── Agentlet Profile ────────────────────────────────────────────────────────

/** Agentlet adapter profile (sent in agentlet/hello) */
export interface AgentletProfile {
  /** Agentlet adapter identity */
  bridge: {
    name: string
    version: string
  }

  /** Machine info (informational) */
  machine?: {
    hostname: string
    platform: string
  }

  /** Agentlet capabilities */
  capabilities: {
    autoRestart: boolean
    bufferLimit: number
    maxAgents?: number
  }
}

// ─── Session Profile & Spec ──────────────────────────────────────────────────

/** All session metadata bundled into a single profile object */
export interface SessionProfile {
  /** Parent agentlet identifier — links this session to its agentlet control channel */
  agentletId: string

  /** Copy of the agentlet's profile for server-side context */
  agentletProfile?: AgentletProfile

  /** Host-side correlation ID (e.g., canvas node ID, chat tab ID). Absent for CLI self-spawn. */
  appId?: string

  /** Agentlet adapter identity */
  bridge: {
    name: string
    version: string
  }

  /** Spawned agent process info */
  agent: {
    command: string
    pid: number
    cwd: string
  }

  /** ACP session capabilities (present after session bootstrap) */
  session?: {
    supportsLoad: boolean
    supportsResume: boolean
    initializeResult: unknown
    /**
     * The full ACP `session/new` response when this profile came from a
     * freshly-created session (absent on resume/load). Opaque to agentlet;
     * may carry inline `models` / `modes` / `configOptions` that the host
     * uses to seed its UI without waiting for the first prompt.
     */
    newSessionResult?: unknown
  }

  /** Machine info (informational) */
  machine?: {
    hostname: string
    platform: string
  }

  /** Agentlet capabilities */
  capabilities: {
    autoRestart: boolean
    bufferLimit: number
    maxAgents?: number
  }
}

/** Specification for spawning a new agent */
export interface SessionSpec {
  /** Shell command to spawn the agent (must support ACP stdio) */
  command: string
  /** Working directory for the agent subprocess */
  cwd?: string
  /** Extra environment variables for the agent */
  env?: Record<string, string>
  /** Whether to auto-restart the agent on crash */
  autoRestart?: boolean
  /** Seconds of inactivity before suspending. 0 or omitted = no timeout. */
  idleTimeoutSecs?: number
}

// ─── agentlet/hello (Request/Response) ────────────────────────────────────────

/** Parameters sent by the agentlet in the agentlet/hello request */
export interface AgentletHelloParams {
  /** Self-chosen agentlet identifier (should match query param `id`) */
  agentletId: string
  /** Full agentlet adapter profile */
  agentletProfile: AgentletProfile
}

/** Success result returned by the server after agentlet/hello */
export interface AgentletHelloResult {
  /** Server-confirmed agentlet identifier */
  agentletId: string
  status: 'registered'
}

// ─── agent/hello (Request/Response) ──────────────────────────────────────────

/** Parameters sent by the agentlet in the agent/hello request */
export interface AgentHelloParams {
  /** ACP session identifier — primary routing key */
  sessionId: string
  /** All session metadata */
  sessionProfile: SessionProfile
}

/** Success result returned by the server after agent/hello */
export interface AgentHelloResult {
  sessionId: string
  status: 'connected'
}

/** Error returned by the server when agent/hello fails */
export type AgentHelloError = JsonRpcError

// ─── Agent → Server Notifications ────────────────────────────────────────────

/** agent/exited — agent process exited */
export interface AgentExitedParams {
  code: number | null
  signal: string | null
  willRestart: boolean
}

/** agent/restarted — agent restarted after crash */
export interface AgentRestartedParams {
  pid: number
  attempt: number
}

/** agent/goodbye — agentlet shutting down */
export interface AgentGoodbyeParams {
  reason: 'user_interrupt' | 'server_requested' | 'max_restarts_exceeded' | (string & {})
}

/** agent/overflow — buffer limit reached */
export interface AgentOverflowParams {
  dropped: number
}

/** agent/suspended — idle session suspended */
export interface AgentSuspendedParams {
  sessionId: string
  reason: 'idle_timeout' | (string & {})
}

// ─── Server → Agent Notifications ────────────────────────────────────────────

/** server/replay — replay buffered messages after reconnect */
export interface ServerReplayParams {
  messages: AcpMessage[]
}

/** server/ping — keepalive */
export interface ServerPingParams {}

/** agent/pong — keepalive response */
export interface AgentPongParams {}

/** server/shutdown — request agentlet shutdown */
export interface ServerShutdownParams {
  reason: 'token_revoked' | 'server_shutting_down' | 'idle_timeout' | (string & {})
}

// ─── Server → Agentlet Control (spawn/stop/list) ─────────────────────────────

/** server/spawn — spawn agent on agentlet */
export interface SpawnParams {
  /** Host-side correlation ID */
  appId: string
  /** If present, resume an existing session */
  sessionId?: string
  /** How to spawn the agent */
  sessionSpec: SessionSpec
}

/** Successful spawn result */
export interface SpawnResult {
  sessionId: string
  pid: number
}

/** server/stop — stop agent session */
export interface StopParams {
  sessionId: string
}

/** Successful stop result */
export interface StopResult {
  stopped: boolean
}

/** server/list — list agent sessions */
export interface ListParams {}

/** List result */
export interface ListResult {
  agents: Array<{
    sessionId: string
    appId?: string
    command: string
    pid: number
    cwd: string
    status: 'running' | 'starting'
  }>
}

// ─── Server → Agentlet Resource Distribution ──────────────────────────────────

/**
 * server/sendResource — push a file to the daemon for local storage.
 * The `destination` supports `${ENV_VAR}` interpolation against the
 * daemon's env registry (e.g., `${AGENTLET_SIDEBAND_DIR}/tool.mjs`).
 */
export interface SendResourceParams {
  /** Destination path with ${ENV_VAR} interpolation */
  destination: string
  /** File content (text) */
  content: string
}

// ─── Lifecycle Events (surfaced to host app) ──────────────────────────────────

/** Union of all lifecycle events the server surfaces to the host app */
export type LifecycleEvent =
  | { type: 'agent/exited'; code: number | null; signal: string | null; willRestart: boolean }
  | { type: 'agent/restarted'; pid: number; attempt: number }
  | { type: 'agent/overflow'; dropped: number }
  | { type: 'agent/goodbye'; reason: string }
  | { type: 'agent/suspended'; sessionId: string; reason: string }
