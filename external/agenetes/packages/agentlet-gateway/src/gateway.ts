import {
  AgentletMethods,
  AgentMethods,
  ErrorCodes,
  ServerMethods,
  type AgentHelloParams,
  type AgentHelloResult,
  type AgentletHelloParams,
  type AgentletHelloResult,
  type AgentTeamScanParams,
  type AgentTeamScanResult,
  type AgentTeamSetupCancelParams,
  type AgentTeamSetupCancelResult,
  type AgentTeamSetupParams,
  type AgentTeamSetupProgressParams,
  type AgentTeamSetupStartResult,
  type AgentTeamValidateParams,
  type AgentTeamValidateResult,
  type JsonRpcError,
  type JsonRpcMessage,
  type SendResourceParams,
  type SpawnParams,
  type SpawnResult,
  type StopParams,
  type StopResult,
} from '@agentlet/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import { LiveAgentletConnection } from './connection.js';
import { AgentletRequestError } from './request-error.js';

import type {
  AgentletConnection,
  AgentletConnectionStatus,
  AgentletGatewayLogger,
  AgentletGatewayOptions,
} from './types.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SPAWN_REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_OUTBOUND_BUFFER_LIMIT = 100;
const DEFAULT_INBOUND_PRE_ATTACH_BUFFER_LIMIT = 1_000;

const noopLogger: AgentletGatewayLogger = {
  info: () => {},
  warn: () => {},
};

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface HelloRequest {
  jsonrpc: '2.0';
  method: string;
  id: string | number;
  params: Record<string, unknown>;
}

export class AgentletGateway {
  private readonly options: AgentletGatewayOptions;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly agentlets = new Map<string, LiveAgentletConnection>();
  private readonly sessions = new Map<
    string,
    Map<string, LiveAgentletConnection>
  >();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly setupProgressHandlers = new Set<
    (agentletId: string, progress: AgentTeamSetupProgressParams) => void
  >();
  private readonly agentTeamMachineHandlers = new Set<() => void>();
  private readonly handshakeTimeout: number;
  private readonly controlRequestTimeout: number;
  private readonly spawnRequestTimeout: number;
  private readonly outboundBufferLimit: number;
  private readonly inboundPreAttachBufferLimit: number;
  private readonly logger: AgentletGatewayLogger;
  private requestId = 1_000;
  private closed = false;

  constructor(options: AgentletGatewayOptions) {
    this.options = options;
    this.handshakeTimeout =
      options.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.controlRequestTimeout =
      options.controlRequestTimeout ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
    this.spawnRequestTimeout =
      options.spawnRequestTimeout ?? DEFAULT_SPAWN_REQUEST_TIMEOUT_MS;
    this.outboundBufferLimit =
      options.outboundBufferLimit ?? DEFAULT_OUTBOUND_BUFFER_LIMIT;
    this.inboundPreAttachBufferLimit =
      options.inboundPreAttachBufferLimit ??
      DEFAULT_INBOUND_PRE_ATTACH_BUFFER_LIMIT;
    this.logger = options.logger ?? noopLogger;
    this.assertPositiveInteger(this.outboundBufferLimit, 'outboundBufferLimit');
    this.assertPositiveInteger(
      this.inboundPreAttachBufferLimit,
      'inboundPreAttachBufferLimit',
    );
  }

  get connectionCount(): number {
    let count = this.agentlets.size;
    for (const sessions of this.sessions.values()) {
      count += sessions.size;
    }
    return count;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onWebSocket(ws, request);
    });
  }

  getAgentlet(agentletId: string): AgentletConnection | undefined {
    return this.agentlets.get(agentletId);
  }

  getAgentlets(filter?: {
    status?: AgentletConnectionStatus;
  }): AgentletConnection[] {
    return [...this.agentlets.values()].filter(
      (connection) =>
        filter?.status === undefined || connection.status === filter.status,
    );
  }

  listAgentTeamMachines(): Array<{
    machine: string;
    hostname: string;
    platform: string;
  }> {
    return this.getAgentlets({ status: 'connected' }).flatMap((connection) => {
      const machine = connection.agentletProfile?.machine;
      return machine
        ? [
            {
              machine: connection.agentletId,
              hostname: machine.hostname,
              platform: machine.platform,
            },
          ]
        : [];
    });
  }

  onAgentTeamMachinesChanged(handler: () => void): () => void {
    this.agentTeamMachineHandlers.add(handler);
    return () => this.agentTeamMachineHandlers.delete(handler);
  }

  getSession(
    agentletId: string,
    nativeSessionId: string,
  ): AgentletConnection | undefined {
    return this.sessions.get(agentletId)?.get(nativeSessionId);
  }

  getSessions(
    agentletId?: string,
    filter?: { status?: AgentletConnectionStatus },
  ): AgentletConnection[] {
    const connections = agentletId
      ? [...(this.sessions.get(agentletId)?.values() ?? [])]
      : [...this.sessions.values()].flatMap((sessions) => [
          ...sessions.values(),
        ]);
    return connections.filter(
      (connection) =>
        filter?.status === undefined || connection.status === filter.status,
    );
  }

  spawnOnAgentlet(
    agentletId: string,
    params: SpawnParams,
  ): Promise<SpawnResult> {
    return this.sendControlRequest(
      agentletId,
      ServerMethods.SPAWN,
      params,
      this.spawnRequestTimeout,
    );
  }

  stopOnAgentlet(agentletId: string, params: StopParams): Promise<StopResult> {
    return this.sendControlRequest(agentletId, ServerMethods.STOP, params);
  }

  listOnAgentlet(agentletId: string): Promise<{
    agents: Array<{
      sessionId: string;
      appId?: string;
      command: string;
      pid: number;
      cwd: string;
      status: string;
    }>;
  }> {
    return this.sendControlRequest(agentletId, ServerMethods.LIST, {});
  }

  scanAgentTeams(
    agentletId: string,
    params: AgentTeamScanParams,
  ): Promise<AgentTeamScanResult> {
    return this.sendControlRequest(
      agentletId,
      ServerMethods.AGENT_TEAM_SCAN,
      params,
    );
  }

  setupAgentTeam(
    agentletId: string,
    params: AgentTeamSetupParams,
  ): Promise<AgentTeamSetupStartResult> {
    return this.sendControlRequest(
      agentletId,
      ServerMethods.AGENT_TEAM_SETUP,
      params,
    );
  }

  cancelAgentTeamSetup(
    agentletId: string,
    params: AgentTeamSetupCancelParams,
  ): Promise<AgentTeamSetupCancelResult> {
    return this.sendControlRequest(
      agentletId,
      ServerMethods.AGENT_TEAM_SETUP_CANCEL,
      params,
    );
  }

  validateAgentTeam(
    agentletId: string,
    params: AgentTeamValidateParams,
  ): Promise<AgentTeamValidateResult> {
    return this.sendControlRequest(
      agentletId,
      ServerMethods.AGENT_TEAM_VALIDATE,
      params,
    );
  }

  onAgentTeamSetupProgress(
    handler: (
      agentletId: string,
      progress: AgentTeamSetupProgressParams,
    ) => void,
  ): () => void {
    this.setupProgressHandlers.add(handler);
    return () => this.setupProgressHandlers.delete(handler);
  }

  sendResource(agentletId: string, params: SendResourceParams): void {
    const connection = this.agentlets.get(agentletId);
    if (!connection || connection.status !== 'connected') return;
    connection.sendRaw({
      jsonrpc: '2.0',
      method: ServerMethods.SEND_RESOURCE,
      params: params as unknown as Record<string, unknown>,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.allConnections()) {
      connection.disconnect('server_shutting_down');
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Agentlet Gateway closed'));
    }
    for (const ws of this.wss.clients) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(1001, 'server_shutting_down');
      }
    }
    this.pendingRequests.clear();
    this.agentlets.clear();
    this.sessions.clear();
    this.wss.close();
  }

  private onWebSocket(ws: WebSocket, request: IncomingMessage): void {
    let handshakeComplete = false;
    const url = new URL(request.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const queryRole = url.searchParams.get('role');
    const queryId = url.searchParams.get('id') ?? '';

    const handshakeTimer = setTimeout(() => {
      if (handshakeComplete) return;
      this.sendError(ws, 1, {
        code: ErrorCodes.HANDSHAKE_TIMEOUT,
        message: 'Handshake timeout',
      });
      ws.close(4003, 'Handshake timeout');
    }, this.handshakeTimeout);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        ws.close(4002, 'Binary frames not supported');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.close(4001, 'Invalid JSON');
        return;
      }
      if (!this.isJsonRpcMessage(parsed)) {
        this.rejectInvalidHello(ws, 1, 'Invalid JSON-RPC message');
        return;
      }
      const message = parsed;

      if (!handshakeComplete) {
        if (!this.isHelloRequest(message)) {
          this.rejectInvalidHello(ws, 1, 'Expected hello request');
          return;
        }
        const hello = message;
        clearTimeout(handshakeTimer);
        handshakeComplete = true;
        if (hello.method === AgentletMethods.HELLO) {
          if (queryRole && queryRole !== 'agentlet') {
            ws.close(
              4004,
              `Role mismatch: expected ${queryRole} hello, got agentlet/hello`,
            );
            return;
          }
          await this.handleAgentletHello(ws, token, queryId, hello);
        } else if (hello.method === AgentMethods.HELLO) {
          if (queryRole && queryRole !== 'session') {
            ws.close(
              4004,
              `Role mismatch: expected ${queryRole} hello, got agent/hello`,
            );
            return;
          }
          await this.handleSessionHello(ws, token, hello);
        } else {
          ws.close(4004, 'Expected agentlet/hello or agent/hello');
        }
        return;
      }

      const connection = this.findConnectionByWs(ws);
      if (!connection) return;
      if (
        connection.role === 'agentlet' &&
        'id' in message &&
        !('method' in message) &&
        this.hasPendingRequest(connection.agentletId, message.id)
      ) {
        this.handlePendingResponse(connection.agentletId, message);
      } else if (
        connection.role === 'agentlet' &&
        'method' in message &&
        message.method === AgentletMethods.AGENT_TEAM_SETUP_PROGRESS
      ) {
        for (const handler of this.setupProgressHandlers) {
          try {
            handler(
              connection.agentletId,
              message.params as unknown as AgentTeamSetupProgressParams,
            );
          } catch (error) {
            this.logger.warn(
              {
                agentletId: connection.agentletId,
                error: error instanceof Error ? error.message : String(error),
              },
              'Agent Team setup progress handler failed',
            );
          }
        }
      } else {
        connection.handleIncomingMessage(message);
      }
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      const connection = this.findConnectionByWs(ws);
      if (!connection) return;
      connection.handleWsClose('websocket_closed');
      this.notifyDisconnection(connection, 'websocket_closed');
    });

    ws.on('error', () => {
      clearTimeout(handshakeTimer);
    });
  }

  private async handleAgentletHello(
    ws: WebSocket,
    token: string,
    queryId: string,
    message: HelloRequest,
  ): Promise<void> {
    const params = message.params as unknown as AgentletHelloParams;
    if (!params.agentletId || !params.agentletProfile) {
      this.rejectInvalidHello(
        ws,
        message.id,
        'Missing agentletId or agentletProfile',
      );
      return;
    }
    if (queryId && queryId !== params.agentletId) {
      this.rejectInvalidHello(
        ws,
        message.id,
        `Query param id "${queryId}" does not match agentletId "${params.agentletId}"`,
      );
      return;
    }

    let auth;
    try {
      auth = await this.options.authenticateAgentlet(params.agentletId, token);
    } catch (error) {
      this.rejectAuthentication(ws, message.id, error);
      return;
    }
    if (this.closed || ws.readyState !== WebSocket.OPEN) return;

    const existing = this.agentlets.get(params.agentletId);
    if (existing) {
      existing.handleReconnect(ws, {
        agentletProfile: params.agentletProfile,
      });
      this.sendResult(ws, message.id, {
        agentletId: params.agentletId,
        status: 'registered',
      } satisfies AgentletHelloResult);
      existing.flushOutboundBuffer();
      this.notifyConnectionCallback(
        'onReconnection',
        this.options.onReconnection,
        existing,
      );
      this.notifyAgentTeamMachinesChanged();
      return;
    }

    const connection = new LiveAgentletConnection({
      sessionId: params.agentletId,
      agentletId: params.agentletId,
      role: 'agentlet',
      metadata: auth.metadata ?? {},
      ws,
      outboundBufferLimit: this.outboundBufferLimit,
      inboundPreAttachBufferLimit: this.inboundPreAttachBufferLimit,
      logger: this.logger,
      agentletProfile: params.agentletProfile,
    });
    this.agentlets.set(params.agentletId, connection);
    this.sendResult(ws, message.id, {
      agentletId: params.agentletId,
      status: 'registered',
    } satisfies AgentletHelloResult);
    this.notifyConnectionCallback(
      'onConnection',
      this.options.onConnection,
      connection,
    );
    this.notifyAgentTeamMachinesChanged();
  }

  private async handleSessionHello(
    ws: WebSocket,
    token: string,
    message: HelloRequest,
  ): Promise<void> {
    const params = message.params as unknown as AgentHelloParams;
    const agentletId = params.sessionProfile?.agentletId;
    if (!params.sessionId || !params.sessionProfile || !agentletId) {
      this.rejectInvalidHello(
        ws,
        message.id,
        'Missing sessionId, sessionProfile, or sessionProfile.agentletId',
      );
      return;
    }

    let auth;
    try {
      auth = await this.options.authenticateAgentlet(agentletId, token);
    } catch (error) {
      this.rejectAuthentication(ws, message.id, error);
      return;
    }
    if (this.closed || ws.readyState !== WebSocket.OPEN) return;

    let sessions = this.sessions.get(agentletId);
    if (!sessions) {
      sessions = new Map();
      this.sessions.set(agentletId, sessions);
    }
    const existing = sessions.get(params.sessionId);
    if (existing) {
      existing.handleReconnect(ws, {
        sessionProfile: params.sessionProfile,
      });
      this.sendResult(ws, message.id, {
        sessionId: params.sessionId,
        status: 'connected',
      } satisfies AgentHelloResult);
      existing.flushOutboundBuffer();
      this.notifyConnectionCallback(
        'onReconnection',
        this.options.onReconnection,
        existing,
      );
      return;
    }

    const connection = new LiveAgentletConnection({
      sessionId: params.sessionId,
      agentletId,
      role: 'agent-session',
      metadata: auth.metadata ?? {},
      ws,
      outboundBufferLimit: this.outboundBufferLimit,
      inboundPreAttachBufferLimit: this.inboundPreAttachBufferLimit,
      logger: this.logger,
      sessionProfile: params.sessionProfile,
    });
    sessions.set(params.sessionId, connection);
    this.sendResult(ws, message.id, {
      sessionId: params.sessionId,
      status: 'connected',
    } satisfies AgentHelloResult);
    this.notifyConnectionCallback(
      'onConnection',
      this.options.onConnection,
      connection,
    );
  }

  private async sendControlRequest<T>(
    agentletId: string,
    method: string,
    params: unknown,
    timeoutMs = this.controlRequestTimeout,
  ): Promise<T> {
    const connection = this.requireConnectedAgentlet(agentletId);
    const id = ++this.requestId;
    const key = this.requestKey(agentletId, id);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`Agentlet request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      connection.sendRaw({
        jsonrpc: '2.0',
        method,
        id,
        params: params as Record<string, unknown>,
      });
    });
  }

  private requireConnectedAgentlet(agentletId: string): LiveAgentletConnection {
    const connection = this.agentlets.get(agentletId);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`Agentlet not found or disconnected: ${agentletId}`);
    }
    return connection;
  }

  private handlePendingResponse(
    agentletId: string,
    message: JsonRpcMessage,
  ): void {
    if (!('id' in message)) return;
    const key = this.requestKey(agentletId, message.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(key);
    if ('error' in message && message.error) {
      pending.reject(new AgentletRequestError(message.error));
    } else if ('result' in message) {
      pending.resolve(message.result);
    }
  }

  private hasPendingRequest(agentletId: string, id: string | number): boolean {
    return this.pendingRequests.has(this.requestKey(agentletId, id));
  }

  private requestKey(agentletId: string, id: string | number): string {
    return `${agentletId}:${id}`;
  }

  private findConnectionByWs(
    ws: WebSocket,
  ): LiveAgentletConnection | undefined {
    for (const connection of this.allConnections()) {
      if (connection.hasWs(ws)) return connection;
    }
    return undefined;
  }

  private allConnections(): LiveAgentletConnection[] {
    return [
      ...this.agentlets.values(),
      ...[...this.sessions.values()].flatMap((sessions) => [
        ...sessions.values(),
      ]),
    ];
  }

  private rejectInvalidHello(
    ws: WebSocket,
    id: string | number,
    message: string,
  ): void {
    this.sendError(ws, id, {
      code: ErrorCodes.INVALID_REQUEST,
      message,
    });
    ws.close(4001, 'Invalid hello params');
  }

  private rejectAuthentication(
    ws: WebSocket,
    id: string | number,
    error: unknown,
  ): void {
    this.sendError(ws, id, {
      code: ErrorCodes.INVALID_TOKEN,
      message: error instanceof Error ? error.message : 'Authentication failed',
    });
    ws.close(4001, 'Authentication failed');
  }

  private sendResult(
    ws: WebSocket,
    id: string | number,
    result: unknown,
  ): void {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private sendError(
    ws: WebSocket,
    id: string | number,
    error: JsonRpcError,
  ): void {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
  }

  private notifyConnectionCallback(
    name: 'onConnection' | 'onReconnection',
    callback: ((connection: AgentletConnection) => void) | undefined,
    connection: AgentletConnection,
  ): void {
    if (!callback) return;
    try {
      callback(connection);
    } catch (error) {
      this.logger.warn(
        {
          callback: name,
          agentletId: connection.agentletId,
          sessionId: connection.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Agentlet Gateway lifecycle callback failed',
      );
    }
  }

  private notifyDisconnection(
    connection: AgentletConnection,
    reason: string,
  ): void {
    if (connection.role === 'agentlet') {
      this.notifyAgentTeamMachinesChanged();
    }
    const callback = this.options.onDisconnection;
    if (!callback) return;
    try {
      callback(connection, reason);
    } catch (error) {
      this.logger.warn(
        {
          callback: 'onDisconnection',
          agentletId: connection.agentletId,
          sessionId: connection.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Agentlet Gateway lifecycle callback failed',
      );
    }
  }

  private notifyAgentTeamMachinesChanged(): void {
    for (const handler of this.agentTeamMachineHandlers) {
      try {
        handler();
      } catch (error) {
        this.logger.warn(
          {
            callback: 'onAgentTeamMachinesChanged',
            error: error instanceof Error ? error.message : String(error),
          },
          'Agentlet Gateway machine-list callback failed',
        );
      }
    }
  }

  private assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }

  private isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>)['jsonrpc'] === '2.0'
    );
  }

  private isHelloRequest(message: JsonRpcMessage): message is HelloRequest {
    if (!('method' in message) || !('id' in message)) return false;
    if (typeof message.method !== 'string') return false;
    if (typeof message.id !== 'string' && typeof message.id !== 'number') {
      return false;
    }
    return (
      'params' in message &&
      typeof message.params === 'object' &&
      message.params !== null &&
      !Array.isArray(message.params)
    );
  }
}
