// @agentlet/protocol — Shared type definitions for the Agentlet protocol
//
// This package is the single source of truth for all protocol types.
// Both the `agentlet` daemon and its host-side Gateway depend on it.

export {
  PROTOCOL_VERSION,
  AgentletMethods,
  AgentMethods,
  ServerMethods,
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
  SessionResumeUnavailableErrorData,
  StopParams,
  StopResult,
  ListParams,
  ListResult,
  SendResourceParams,
  AgentTeamEnvField,
  AgentTeamScanParams,
  AgentTeamScanMember,
  AgentTeamScanDiagnostic,
  AgentTeamScanResult,
  AgentTeamSetupParams,
  AgentTeamSetupStartResult,
  AgentTeamSetupProgressParams,
  AgentTeamSetupCancelParams,
  AgentTeamSetupCancelResult,
  AgentTeamValidateParams,
  AgentTeamValidationIssue,
  AgentTeamValidateResult,
  LifecycleEvent,
} from './messages.js'

export type {
  AuthResult,
  AgentConnection,
} from './gateway-types.js'
