import type {
  AcpMessage,
  AgentletProfile,
  LifecycleEvent,
  SessionProfile,
} from '@agentlet/protocol';

export type AgentletConnectionRole = 'agentlet' | 'agent-session';
export type AgentletConnectionStatus = 'connected' | 'disconnected';

export interface AgentletAuthenticationResult {
  metadata?: Record<string, unknown>;
}

export interface AgentletGatewayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AgentletGatewayOptions {
  authenticateAgentlet(
    agentletId: string,
    token: string,
  ): AgentletAuthenticationResult | Promise<AgentletAuthenticationResult>;
  onConnection?(connection: AgentletConnection): void;
  onReconnection?(connection: AgentletConnection): void;
  onDisconnection?(connection: AgentletConnection, reason: string): void;
  handshakeTimeout?: number;
  controlRequestTimeout?: number;
  spawnRequestTimeout?: number;
  outboundBufferLimit?: number;
  inboundPreAttachBufferLimit?: number;
  logger?: AgentletGatewayLogger;
}

export interface AgentletConnection {
  readonly sessionId: string;
  readonly agentletId: string;
  readonly role: AgentletConnectionRole;
  readonly metadata: Record<string, unknown>;
  readonly status: AgentletConnectionStatus;
  readonly connectedAt: Date;
  readonly sessionProfile: SessionProfile | undefined;
  readonly agentletProfile: AgentletProfile | undefined;

  send(message: AcpMessage): void;
  onMessage(handler: (message: AcpMessage) => void): void;
  onLifecycle(handler: (event: LifecycleEvent) => void): void;
  disconnect(reason?: string): void;
}
