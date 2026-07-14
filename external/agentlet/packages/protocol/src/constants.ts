/** Protocol version */
export const PROTOCOL_VERSION = '1.0.0'

/** Agentlet → Server method names */
export const AgentletMethods = {
  HELLO: 'agentlet/hello',
  AGENT_TEAM_SETUP_PROGRESS: 'agent-team/setup-progress',
} as const

/** Agent → Server method names */
export const AgentMethods = {
  HELLO: 'agent/hello',
  EXITED: 'agent/exited',
  RESTARTED: 'agent/restarted',
  GOODBYE: 'agent/goodbye',
  OVERFLOW: 'agent/overflow',
  SUSPENDED: 'agent/suspended',
  PONG: 'agent/pong',
} as const

/** Server → Agent method names */
export const ServerMethods = {
  REPLAY: 'server/replay',
  PING: 'server/ping',
  SHUTDOWN: 'server/shutdown',
  SPAWN: 'server/spawn',
  STOP: 'server/stop',
  LIST: 'server/list',
  SEND_RESOURCE: 'server/sendResource',
  AGENT_TEAM_SCAN: 'agent-team/scan',
  AGENT_TEAM_SETUP: 'agent-team/setup',
  AGENT_TEAM_SETUP_CANCEL: 'agent-team/setup-cancel',
  AGENT_TEAM_VALIDATE: 'agent-team/validate',
} as const

/** Error codes used in agent/hello rejection */
export const ErrorCodes = {
  INVALID_TOKEN: -32001,
  VERSION_MISMATCH: -32002,
  HANDSHAKE_TIMEOUT: -32003,
  DUPLICATE_SESSION: -32004,
  INVALID_REQUEST: -32600,
  PARSE_ERROR: -32700,
} as const
