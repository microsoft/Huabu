export { AgentletGateway } from './gateway.js';
export { AgentletRequestError } from './request-error.js';
export { AgentletGatewayError } from './harness-discovery.js';

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
  LifecycleEvent,
  SessionProfile,
  HarnessDiscoveryParams,
  HarnessDiscoveryResult,
  HarnessDiscoveryEntry,
  HarnessCatalogueEntry,
} from '@agentlet/protocol';
