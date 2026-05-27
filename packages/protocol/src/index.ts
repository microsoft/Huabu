// @agentlet/protocol — Shared type definitions for the Agentlet bridge protocol
//
// This package is the single source of truth for all protocol types.
// Both `agentlet` (agent-side CLI) and `@agentlet/server` (relay server) depend on it.

export {
  PROTOCOL_VERSION,
  BridgeMethods,
  BridgeErrorCodes,
} from './constants.js'

export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcResponse,
  JsonRpcMessage,
  AcpMessage,
} from './json-rpc.js'

export type {
  BridgeHelloParams,
  BridgeHelloResult,
  BridgeHelloError,
  BridgeAgentExitedParams,
  BridgeAgentRestartedParams,
  BridgeGoodbyeParams,
  BridgeBufferOverflowParams,
  BridgeReplayParams,
  BridgePingParams,
  BridgePongParams,
  BridgeShutdownParams,
  BridgeLifecycleEvent,
} from './bridge-messages.js'

export type {
  AgentletServerOptions,
  AuthResult,
  AgentConnection,
} from './gateway-types.js'
