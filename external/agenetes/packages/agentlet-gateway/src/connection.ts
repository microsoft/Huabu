import {
  AgentMethods,
  ServerMethods,
  type AcpMessage,
  type AgentletProfile,
  type JsonRpcMessage,
  type LifecycleEvent,
  type SessionProfile,
} from '@agentlet/protocol';
import WebSocket from 'ws';

import type {
  AgentletConnection,
  AgentletConnectionRole,
  AgentletConnectionStatus,
  AgentletGatewayLogger,
} from './types.js';

export interface LiveAgentletConnectionOptions {
  sessionId: string;
  agentletId: string;
  role: AgentletConnectionRole;
  metadata: Record<string, unknown>;
  ws: WebSocket;
  outboundBufferLimit: number;
  inboundPreAttachBufferLimit: number;
  logger: AgentletGatewayLogger;
  sessionProfile?: SessionProfile;
  agentletProfile?: AgentletProfile;
}

export class LiveAgentletConnection implements AgentletConnection {
  readonly sessionId: string;
  readonly agentletId: string;
  readonly role: AgentletConnectionRole;
  readonly metadata: Record<string, unknown>;
  readonly connectedAt: Date;

  private ws: WebSocket | null;
  private currentStatus: AgentletConnectionStatus = 'connected';
  private currentSessionProfile?: SessionProfile;
  private currentAgentletProfile?: AgentletProfile;
  private readonly outboundBuffer: AcpMessage[] = [];
  private readonly inboundPreAttachBuffer: AcpMessage[] = [];
  private readonly messageHandlers: Array<(message: AcpMessage) => void> = [];
  private readonly lifecycleHandlers: Array<(event: LifecycleEvent) => void> =
    [];
  private readonly outboundBufferLimit: number;
  private readonly inboundPreAttachBufferLimit: number;
  private readonly logger: AgentletGatewayLogger;
  private firstMessageHandlerAttached = false;

  constructor(options: LiveAgentletConnectionOptions) {
    this.sessionId = options.sessionId;
    this.agentletId = options.agentletId;
    this.role = options.role;
    this.metadata = options.metadata;
    this.ws = options.ws;
    this.outboundBufferLimit = options.outboundBufferLimit;
    this.inboundPreAttachBufferLimit = options.inboundPreAttachBufferLimit;
    this.logger = options.logger;
    this.currentSessionProfile = options.sessionProfile;
    this.currentAgentletProfile = options.agentletProfile;
    this.connectedAt = new Date();
  }

  get status(): AgentletConnectionStatus {
    return this.currentStatus;
  }

  get sessionProfile(): SessionProfile | undefined {
    return this.currentSessionProfile;
  }

  get agentletProfile(): AgentletProfile | undefined {
    return this.currentAgentletProfile;
  }

  send(message: AcpMessage): void {
    if (
      this.currentStatus === 'connected' &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    if (this.outboundBuffer.length >= this.outboundBufferLimit) {
      throw new Error(
        `Outbound buffer full (${this.outboundBufferLimit} messages). Cannot buffer more messages for ${this.sessionId}.`,
      );
    }
    this.outboundBuffer.push(message);
  }

  onMessage(handler: (message: AcpMessage) => void): void {
    this.messageHandlers.push(handler);
    if (this.firstMessageHandlerAttached) return;

    this.firstMessageHandlerAttached = true;
    const buffered = this.inboundPreAttachBuffer.splice(0);
    for (const message of buffered) {
      handler(message);
    }
  }

  onLifecycle(handler: (event: LifecycleEvent) => void): void {
    this.lifecycleHandlers.push(handler);
  }

  disconnect(reason?: string): void {
    const shutdown = {
      jsonrpc: '2.0' as const,
      method: ServerMethods.SHUTDOWN,
      params: { reason: reason ?? 'server_requested' },
    };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(shutdown));
      this.ws.close(1000, reason ?? 'server_requested');
    }
    this.currentStatus = 'disconnected';
    this.ws = null;
  }

  handleIncomingMessage(message: JsonRpcMessage): void {
    if (
      'method' in message &&
      typeof message.method === 'string' &&
      this.handleProtocolMessage(message.method, message)
    ) {
      return;
    }

    const acpMessage = message as AcpMessage;
    if (!this.firstMessageHandlerAttached) {
      if (
        this.inboundPreAttachBuffer.length >= this.inboundPreAttachBufferLimit
      ) {
        this.inboundPreAttachBuffer.shift();
        this.logger.warn(
          {
            agentletId: this.agentletId,
            sessionId: this.sessionId,
            limit: this.inboundPreAttachBufferLimit,
          },
          'Agentlet session pre-attach buffer overflow; dropped oldest message',
        );
      }
      this.inboundPreAttachBuffer.push(acpMessage);
      return;
    }

    for (const handler of this.messageHandlers) {
      handler(acpMessage);
    }
  }

  handleWsClose(reason = 'websocket_closed'): void {
    this.currentStatus = 'disconnected';
    this.ws = null;
    for (const handler of this.lifecycleHandlers) {
      handler({ type: 'agent/disconnected', reason });
    }
  }

  handleReconnect(
    ws: WebSocket,
    profiles?: {
      sessionProfile?: SessionProfile;
      agentletProfile?: AgentletProfile;
    },
  ): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'replaced_by_reconnection');
    }
    this.ws = ws;
    this.currentStatus = 'connected';
    if (profiles?.sessionProfile) {
      this.currentSessionProfile = profiles.sessionProfile;
    }
    if (profiles?.agentletProfile) {
      this.currentAgentletProfile = profiles.agentletProfile;
    }
  }

  flushOutboundBuffer(): void {
    if (this.outboundBuffer.length === 0) return;
    const replay = {
      jsonrpc: '2.0' as const,
      method: ServerMethods.REPLAY,
      params: { messages: this.outboundBuffer },
    };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(replay));
      this.outboundBuffer.length = 0;
    }
  }

  hasWs(ws: WebSocket): boolean {
    return this.ws === ws;
  }

  sendRaw(message: JsonRpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleProtocolMessage(
    method: string,
    message: JsonRpcMessage,
  ): boolean {
    const params =
      'params' in message
        ? (message.params as Record<string, unknown>)
        : undefined;

    let event: LifecycleEvent | undefined;
    switch (method) {
      case AgentMethods.EXITED:
        event = {
          type: 'agent/exited',
          code: (params?.['code'] as number | null) ?? null,
          signal: (params?.['signal'] as string | null) ?? null,
          willRestart: (params?.['willRestart'] as boolean) ?? false,
        };
        break;
      case AgentMethods.RESTARTED:
        event = {
          type: 'agent/restarted',
          pid: params?.['pid'] as number,
          attempt: params?.['attempt'] as number,
        };
        break;
      case AgentMethods.OVERFLOW:
        event = {
          type: 'agent/overflow',
          dropped: params?.['dropped'] as number,
        };
        break;
      case AgentMethods.GOODBYE:
        event = {
          type: 'agent/goodbye',
          reason: (params?.['reason'] as string) ?? 'unknown',
        };
        break;
      case AgentMethods.SUSPENDED:
        event = {
          type: 'agent/suspended',
          sessionId: params?.['sessionId'] as string,
          reason: (params?.['reason'] as string) ?? 'unknown',
        };
        break;
      default:
        return false;
    }

    for (const handler of this.lifecycleHandlers) {
      handler(event);
    }
    return true;
  }
}
