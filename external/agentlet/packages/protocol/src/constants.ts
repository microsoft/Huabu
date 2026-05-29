/** Protocol version */
export const PROTOCOL_VERSION = '1.0.0'

/** Bridge method names */
export const BridgeMethods = {
  HELLO: 'bridge/hello',
  AGENT_EXITED: 'bridge/agent_exited',
  AGENT_RESTARTED: 'bridge/agent_restarted',
  GOODBYE: 'bridge/goodbye',
  BUFFER_OVERFLOW: 'bridge/buffer_overflow',
  REPLAY: 'bridge/replay',
  PING: 'bridge/ping',
  PONG: 'bridge/pong',
  SHUTDOWN: 'bridge/shutdown',
} as const

/** Error codes used in bridge/hello rejection */
export const BridgeErrorCodes = {
  INVALID_TOKEN: -32001,
  VERSION_MISMATCH: -32002,
  HANDSHAKE_TIMEOUT: -32003,
  INVALID_REQUEST: -32600,
  PARSE_ERROR: -32700,
} as const
