import {
  AgentletMethods,
  PROTOCOL_VERSION,
  type JsonRpcMessage,
} from '@agentlet/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { _resetDaemonAuthForTests, getDaemonAuth } from './daemon-auth.js';
import { ACP_UPGRADE_PATH, mountAgentletGateway } from './gateway-mount.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  _resetDaemonAuthForTests();
});

describe('Agentlet Gateway mount', () => {
  it('rejects a token presented for another machine identity', () => {
    const auth = getDaemonAuth();
    auth.configure('machine-a', 'test-token');

    expect(() => auth.validateAgentlet('machine-b', 'test-token')).toThrow(
      'Invalid supervised agentlet identity',
    );
  });

  it('authenticates the supervised identity and closes upgraded sockets', async () => {
    getDaemonAuth().configure('machine-a', 'test-token');
    app = Fastify({ logger: false });
    const gateway = mountAgentletGateway(app, {});
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}${ACP_UPGRADE_PATH}?token=test-token&role=agentlet&id=machine-a`,
    );
    const messages: JsonRpcMessage[] = [];
    socket.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as JsonRpcMessage);
    });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: AgentletMethods.HELLO,
        id: 1,
        params: {
          agentletId: 'machine-a',
          agentletProfile: {
            bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
            machine: { hostname: 'machine-a', platform: process.platform },
            capabilities: {
              autoRestart: true,
              bufferLimit: 1000,
              maxAgents: 10,
            },
          },
        },
      }),
    );

    await expect
      .poll(() => messages.some((message) => 'result' in message))
      .toBe(true);
    expect(gateway.getAgentlet('machine-a')?.status).toBe('connected');

    await expect(
      Promise.race([
        app.close().then(() => 'closed'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('timeout'), 1000),
        ),
      ]),
    ).resolves.toBe('closed');
    app = undefined;
    await expect
      .poll(() => socket.readyState, { timeout: 1000 })
      .toBe(WebSocket.CLOSED);
  });
});
