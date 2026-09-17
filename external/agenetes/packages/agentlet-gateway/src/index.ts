export { AgentletGateway } from './gateway.js';
export { AgentletRequestError } from './request-error.js';

export type {
  AgentletAuthenticationResult,
  AgentletConnection,
  AgentletConnectionRole,
  AgentletConnectionStatus,
  AgentletGatewayLogger,
  AgentletGatewayOptions,
} from './types.js';

export type {
  AcpMessage,
  AgentletProfile,
  DiscoverHarnessesParams,
  DiscoverHarnessesResult,
  HarnessDiscoveryCandidate,
  HarnessDiscoveryObservation,
  LifecycleEvent,
  MachineControlErrorData,
  NativePathErrorCode,
  SessionProfile,
  ValidateNativePathParams,
  ValidateNativePathResult,
} from '@agentlet/protocol';
