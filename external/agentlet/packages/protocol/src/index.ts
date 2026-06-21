// @agentlet/protocol — Shared type definitions for the Agentlet protocol
//
// This package is the single source of truth for all protocol types.
// Both `agentlet` (agent-side CLI) and `@agentlet/server` (relay server) depend on it.

export {
  PROTOCOL_VERSION,
  AgentletMethods,
  AgentMethods,
  ServerMethods,
  HostMethods,
  ServerHostMethods,
  ErrorCodes,
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
  AgentletProfile,
  AgentletHelloParams,
  AgentletHelloResult,
  SessionProfile,
  SessionSpec,
  AgentHelloParams,
  AgentHelloResult,
  AgentHelloError,
  AgentExitedParams,
  AgentRestartedParams,
  AgentGoodbyeParams,
  AgentOverflowParams,
  AgentSuspendedParams,
  ServerReplayParams,
  ServerPingParams,
  AgentPongParams,
  ServerShutdownParams,
  SpawnParams,
  SpawnResult,
  StopParams,
  StopResult,
  ListParams,
  ListResult,
  SendResourceParams,
  LifecycleEvent,
} from './messages.js'

export type {
  AgentletServerOptions,
  AuthResult,
  AgentConnection,
} from './gateway-types.js'
