import { createServer, type Server } from 'node:http';

import {
  AgentletMethods,
  AgentMethods,
  PROTOCOL_VERSION,
  ServerMethods,
  type AgentHelloParams,
  type AgentletHelloParams,
  type JsonRpcMessage,
} from '@agentlet/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AgentletGateway } from './gateway.js';

import type { AgentletGatewayLogger, AgentletGatewayOptions } from './types.js';

interface Harness {
  gateway: AgentletGateway;
  server: Server;
  url: string;
}

interface Client {
  socket: WebSocket;
  messages: JsonRpcMessage[];
}

const harnesses: Harness[] = [];
const clients: Client[] = [];

async function waitUntil(
  predicate: () => boolean,
  timeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startHarness(
  overrides: Partial<AgentletGatewayOptions> = {},
): Promise<Harness> {
  const tokens = new Map([
    ['machine-a', 'token-a'],
    ['machine-b', 'token-b'],
  ]);
  const gateway = new AgentletGateway({
    authenticateAgentlet: (agentletId, token) => {
      if (tokens.get(agentletId) !== token) {
        throw new Error('Invalid daemon credential');
      }
      return { metadata: { agentletId } };
    },
    ...overrides,
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const harness = { gateway, server, url: `ws://127.0.0.1:${port}` };
  harnesses.push(harness);
  return harness;
}

async function connect(
  url: string,
  options: {
    role: 'agentlet' | 'session';
    queryId: string;
    token: string;
    hello: JsonRpcMessage;
  },
): Promise<Client> {
  const socket = new WebSocket(
    `${url}?role=${options.role}&id=${encodeURIComponent(options.queryId)}&token=${encodeURIComponent(options.token)}`,
  );
  const client = { socket, messages: [] as JsonRpcMessage[] };
  clients.push(client);
  socket.on('message', (data) => {
    client.messages.push(JSON.parse(data.toString()) as JsonRpcMessage);
  });
  await new Promise<void>((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify(options.hello));
  await waitUntil(() =>
    client.messages.some((message) => 'id' in message && message.id === 1),
  );
  return client;
}

function agentletHello(agentletId: string): JsonRpcMessage {
  const params: AgentletHelloParams = {
    agentletId,
    agentletProfile: {
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      machine: { hostname: agentletId, platform: process.platform },
      capabilities: { autoRestart: true, bufferLimit: 1000, maxAgents: 10 },
    },
  };
  return {
    jsonrpc: '2.0',
    method: AgentletMethods.HELLO,
    id: 1,
    params: params as unknown as Record<string, unknown>,
  };
}

function sessionHello(
  agentletId: string,
  nativeSessionId: string,
): JsonRpcMessage {
  const params: AgentHelloParams = {
    sessionId: nativeSessionId,
    sessionProfile: {
      agentletId,
      bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
      agent: { command: 'mock-agent', pid: 123, cwd: process.cwd() },
      session: {
        supportsLoad: false,
        supportsResume: false,
        initializeResult: { agentInfo: { name: 'mock-agent' } },
        newSessionResult: { sessionId: nativeSessionId },
      },
      capabilities: { autoRestart: false, bufferLimit: 1000 },
    },
  };
  return {
    jsonrpc: '2.0',
    method: AgentMethods.HELLO,
    id: 1,
    params: params as unknown as Record<string, unknown>,
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (
      client.socket.readyState === WebSocket.OPEN ||
      client.socket.readyState === WebSocket.CONNECTING
    ) {
      client.socket.close();
    }
  }
  for (const harness of harnesses.splice(0)) {
    harness.gateway.close();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
});

describe('AgentletGateway', () => {
  it('surfaces session WebSocket closure as a connection lifecycle event', async () => {
    const { gateway, url } = await startHarness();
    const client = await connect(url, {
      role: 'session',
      queryId: 'session-close',
      token: 'token-a',
      hello: sessionHello('machine-a', 'session-close'),
    });
    const connection = gateway.getSession('machine-a', 'session-close');
    expect(connection).toBeDefined();
    const onLifecycle = vi.fn();
    connection?.onLifecycle(onLifecycle);

    client.socket.close();

    await waitUntil(() => onLifecycle.mock.calls.length > 0);
    expect(onLifecycle).toHaveBeenCalledWith({
      type: 'agent/disconnected',
      reason: 'websocket_closed',
    });
  });

  it('rejects malformed JSON-RPC without registering a connection', async () => {
    const { gateway, url } = await startHarness();
    const socket = new WebSocket(
      `${url}?role=agentlet&id=machine-a&token=token-a`,
    );
    clients.push({ socket, messages: [] });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const closed = new Promise<number>((resolve) =>
      socket.once('close', resolve),
    );

    socket.send('null');

    await expect(closed).resolves.toBe(4001);
    expect(gateway.connectionCount).toBe(0);
  });

  it('does not register a connection when authentication finishes after close', async () => {
    let finishAuthentication:
      | ((value: { metadata: Record<string, unknown> }) => void)
      | undefined;
    const authentication = new Promise<{
      metadata: Record<string, unknown>;
    }>((resolve) => {
      finishAuthentication = resolve;
    });
    const { gateway, url } = await startHarness({
      authenticateAgentlet: () => authentication,
    });
    const socket = new WebSocket(
      `${url}?role=agentlet&id=machine-a&token=token-a`,
    );
    clients.push({ socket, messages: [] });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify(agentletHello('machine-a')));
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));

    finishAuthentication?.({ metadata: { agentletId: 'machine-a' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.getAgentlet('machine-a')).toBeUndefined();
  });

  it('closes sockets that are still awaiting authentication on shutdown', async () => {
    const authentication = new Promise<{
      metadata: Record<string, unknown>;
    }>(() => {});
    const { gateway, url } = await startHarness({
      authenticateAgentlet: () => authentication,
    });
    const socket = new WebSocket(
      `${url}?role=agentlet&id=machine-a&token=token-a`,
    );
    clients.push({ socket, messages: [] });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify(agentletHello('machine-a')));
    const closed = new Promise<number>((resolve) =>
      socket.once('close', resolve),
    );

    gateway.close();

    await expect(closed).resolves.toBe(1001);
    expect(gateway.connectionCount).toBe(0);
  });

  it('keeps a successful handshake when a lifecycle callback throws', async () => {
    const logger: AgentletGatewayLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const { gateway, url } = await startHarness({
      logger,
      onConnection: () => {
        throw new Error('observer failed');
      },
    });

    const client = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });

    expect(client.messages[0]).toMatchObject({
      result: { agentletId: 'machine-a', status: 'registered' },
    });
    expect(gateway.getAgentlet('machine-a')?.status).toBe('connected');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        callback: 'onConnection',
        error: 'observer failed',
      }),
      'Agentlet Gateway lifecycle callback failed',
    );
  });

  it('returns a rejected Promise when the selected daemon is unavailable', async () => {
    const { gateway } = await startHarness();

    await expect(
      gateway.spawnOnAgentlet('missing', {
        appId: 'thread-a',
        sessionSpec: { command: 'mock-agent' },
      }),
    ).rejects.toThrow('Agentlet not found or disconnected: missing');
    expect(() =>
      gateway.sendResource('missing', {
        destination: '/tmp/resource',
        content: 'content',
      }),
    ).not.toThrow();
  });

  it('allows spawn bootstrap to outlive the ordinary control timeout', async () => {
    const { gateway, url } = await startHarness({
      controlRequestTimeout: 20,
      spawnRequestTimeout: 200,
    });
    const agentlet = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });
    agentlet.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as JsonRpcMessage;
      if (
        'method' in message &&
        message.method === ServerMethods.SPAWN &&
        'id' in message
      ) {
        setTimeout(() => {
          agentlet.socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { sessionId: 'slow-bootstrap', pid: 456 },
            }),
          );
        }, 50);
      }
    });

    await expect(
      gateway.spawnOnAgentlet('machine-a', {
        appId: 'thread-a',
        sessionSpec: { command: 'mock-agent' },
      }),
    ).resolves.toEqual({ sessionId: 'slow-bootstrap', pid: 456 });
  });

  it('keys equal native session IDs independently per daemon', async () => {
    const { gateway, url } = await startHarness();

    await connect(url, {
      role: 'session',
      queryId: 'shared-session',
      token: 'token-a',
      hello: sessionHello('machine-a', 'shared-session'),
    });
    await connect(url, {
      role: 'session',
      queryId: 'shared-session',
      token: 'token-b',
      hello: sessionHello('machine-b', 'shared-session'),
    });

    expect(gateway.getSession('machine-a', 'shared-session')).toMatchObject({
      agentletId: 'machine-a',
      sessionId: 'shared-session',
    });
    expect(gateway.getSession('machine-b', 'shared-session')).toMatchObject({
      agentletId: 'machine-b',
      sessionId: 'shared-session',
    });
    expect(gateway.getSessions()).toHaveLength(2);
  });

  it('authenticates sessions without requiring a live control connection', async () => {
    const { gateway, url } = await startHarness();

    const client = await connect(url, {
      role: 'session',
      queryId: 'native-a',
      token: 'token-a',
      hello: sessionHello('machine-a', 'native-a'),
    });

    expect(client.messages[0]).toMatchObject({
      result: { sessionId: 'native-a', status: 'connected' },
    });
    expect(gateway.getAgentlet('machine-a')).toBeUndefined();
    expect(
      gateway.getSession('machine-a', 'native-a')?.sessionProfile,
    ).toMatchObject({
      agentletId: 'machine-a',
      agent: { command: 'mock-agent' },
    });
  });

  it('replaces a same-credential control socket and rejects another credential', async () => {
    const onReconnection = vi.fn();
    const { gateway, url } = await startHarness({ onReconnection });
    const first = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });
    const firstClosed = new Promise<number>((resolve) => {
      first.socket.once('close', resolve);
    });

    await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });

    await expect(firstClosed).resolves.toBe(1000);
    expect(onReconnection).toHaveBeenCalledOnce();
    expect(gateway.getAgentlet('machine-a')?.status).toBe('connected');

    const rejected = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-b',
      hello: agentletHello('machine-a'),
    });
    expect(rejected.messages[0]).toMatchObject({
      error: {
        code: -32001,
        message: 'Invalid daemon credential',
      },
    });
  });

  it('keeps session connections alive when control disconnects', async () => {
    const { gateway, url } = await startHarness();
    const control = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });
    await connect(url, {
      role: 'session',
      queryId: 'native-a',
      token: 'token-a',
      hello: sessionHello('machine-a', 'native-a'),
    });

    control.socket.close();
    await waitUntil(
      () => gateway.getAgentlet('machine-a')?.status === 'disconnected',
    );
    expect(gateway.getSession('machine-a', 'native-a')?.status).toBe(
      'connected',
    );
  });

  it('flushes disconnected outbound messages through server/replay', async () => {
    const { gateway, url } = await startHarness();
    const first = await connect(url, {
      role: 'session',
      queryId: 'native-a',
      token: 'token-a',
      hello: sessionHello('machine-a', 'native-a'),
    });
    first.socket.close();
    await waitUntil(
      () =>
        gateway.getSession('machine-a', 'native-a')?.status === 'disconnected',
    );

    gateway.getSession('machine-a', 'native-a')?.send({
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 42,
      params: {},
    });
    const second = await connect(url, {
      role: 'session',
      queryId: 'native-a',
      token: 'token-a',
      hello: sessionHello('machine-a', 'native-a'),
    });
    await waitUntil(() =>
      second.messages.some(
        (message) =>
          'method' in message && message.method === ServerMethods.REPLAY,
      ),
    );

    expect(
      second.messages.find(
        (message) =>
          'method' in message && message.method === ServerMethods.REPLAY,
      ),
    ).toMatchObject({
      params: {
        messages: [{ id: 42, method: 'session/prompt' }],
      },
    });
  });

  it('drains the bounded pre-attach buffer once in arrival order', async () => {
    const logger: AgentletGatewayLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const { gateway, url } = await startHarness({
      inboundPreAttachBufferLimit: 2,
      logger,
    });
    const client = await connect(url, {
      role: 'session',
      queryId: 'native-a',
      token: 'token-a',
      hello: sessionHello('machine-a', 'native-a'),
    });
    for (const id of [1, 2, 3]) {
      client.socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sequence: id },
        }),
      );
    }
    await waitUntil(() => vi.mocked(logger.warn).mock.calls.length === 1);

    const received: JsonRpcMessage[] = [];
    gateway
      .getSession('machine-a', 'native-a')
      ?.onMessage((message) => received.push(message));
    expect(received).toMatchObject([
      { params: { sequence: 2 } },
      { params: { sequence: 3 } },
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();

    const secondHandler = vi.fn();
    gateway.getSession('machine-a', 'native-a')?.onMessage(secondHandler);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('routes control RPCs to the explicitly selected daemon', async () => {
    const { gateway, url } = await startHarness();
    const setupProgress = vi.fn();
    const machinesChanged = vi.fn();
    gateway.onAgentTeamSetupProgress(setupProgress);
    gateway.onAgentTeamMachinesChanged(machinesChanged);
    const machineA = await connect(url, {
      role: 'agentlet',
      queryId: 'machine-a',
      token: 'token-a',
      hello: agentletHello('machine-a'),
    });
    await connect(url, {
      role: 'agentlet',
      queryId: 'machine-b',
      token: 'token-b',
      hello: agentletHello('machine-b'),
    });
    expect(gateway.listAgentTeamMachines()).toEqual([
      {
        machine: 'machine-a',
        hostname: 'machine-a',
        platform: process.platform,
      },
      {
        machine: 'machine-b',
        hostname: 'machine-b',
        platform: process.platform,
      },
    ]);
    expect(machinesChanged).toHaveBeenCalledTimes(2);
    machineA.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as JsonRpcMessage;
      if (
        'method' in message &&
        message.method === ServerMethods.SPAWN &&
        'id' in message
      ) {
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { sessionId: 'native-a', pid: 456 },
          }),
        );
      }
      if (
        'method' in message &&
        message.method === ServerMethods.AGENT_TEAM_SETUP &&
        'id' in message
      ) {
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              operationId: 'setup-a',
              accepted: true,
            },
          }),
        );
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: AgentletMethods.AGENT_TEAM_SETUP_PROGRESS,
            params: {
              operationId: 'setup-a',
              type: 'completed',
              workingDirPath: '/deployments/reviewer',
            },
          }),
        );
      }
      if (
        'method' in message &&
        message.method === ServerMethods.AGENT_TEAM_SETUP_CANCEL &&
        'id' in message
      ) {
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { operationId: 'setup-a', cancelled: true },
          }),
        );
      }
      if (
        'method' in message &&
        message.method === ServerMethods.AGENT_TEAM_VALIDATE &&
        'id' in message
      ) {
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { valid: true, issues: [] },
          }),
        );
      }
      if (
        'method' in message &&
        message.method === ServerMethods.AGENT_TEAM_SCAN &&
        'id' in message
      ) {
        machineA.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              rootPath: '/teams',
              members: [],
              diagnostics: [],
            },
          }),
        );
      }
    });

    await expect(
      gateway.spawnOnAgentlet('machine-a', {
        appId: 'thread-a',
        sessionSpec: { command: 'mock-agent' },
      }),
    ).resolves.toEqual({ sessionId: 'native-a', pid: 456 });

    await expect(
      gateway.scanAgentTeams('machine-a', { rootPath: '/teams' }),
    ).resolves.toEqual({
      rootPath: '/teams',
      members: [],
      diagnostics: [],
    });

    await expect(
      gateway.setupAgentTeam('machine-a', {
        operationId: 'setup-a',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        harness: 'copilot',
        workingDirPath: '/deployments/reviewer',
      }),
    ).resolves.toEqual({
      operationId: 'setup-a',
      accepted: true,
    });
    await waitUntil(() => setupProgress.mock.calls.length === 1);
    expect(setupProgress).toHaveBeenCalledWith('machine-a', {
      operationId: 'setup-a',
      type: 'completed',
      workingDirPath: '/deployments/reviewer',
    });

    await expect(
      gateway.cancelAgentTeamSetup('machine-a', {
        operationId: 'setup-a',
      }),
    ).resolves.toEqual({ operationId: 'setup-a', cancelled: true });

    await expect(
      gateway.validateAgentTeam('machine-a', {
        manifestPath: '/teams/reviewer/agentlet.yaml',
        harness: 'copilot',
        workingDirPath: '/deployments/reviewer',
      }),
    ).resolves.toEqual({ valid: true, issues: [] });
  });

  it('rejects non-positive buffer limits', () => {
    expect(
      () =>
        new AgentletGateway({
          authenticateAgentlet: () => ({}),
          inboundPreAttachBufferLimit: 0,
        }),
    ).toThrow('inboundPreAttachBufferLimit must be a positive integer');
  });
});
