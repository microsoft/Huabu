import { describe, expect, it, vi } from 'vitest';

import { AcpAgentClient } from './client.js';

import type {
  AgentletConnection,
  AcpMessage,
  LifecycleEvent,
} from '@agenetes/agentlet-host';

function createConnection(): {
  connection: AgentletConnection;
  emitLifecycle(event: LifecycleEvent): void;
} {
  const lifecycleHandlers: Array<(event: LifecycleEvent) => void> = [];
  const connection: AgentletConnection = {
    sessionId: 'session-1',
    agentletId: 'agentlet-1',
    role: 'agent-session',
    metadata: {},
    status: 'connected',
    connectedAt: new Date(0),
    sessionProfile: undefined,
    agentletProfile: undefined,
    send: vi.fn((_message: AcpMessage) => undefined),
    onMessage: vi.fn(),
    onLifecycle: (handler) => lifecycleHandlers.push(handler),
    disconnect: vi.fn(),
  };
  return {
    connection,
    emitLifecycle: (event) => {
      for (const handler of lifecycleHandlers) handler(event);
    },
  };
}

describe('AcpAgentClient lifecycle cleanup', () => {
  it.each(['answer', 'disconnect'] as const)(
    'reports pending approval only for its session and clears it on %s',
    async (finish) => {
      const { connection, emitLifecycle } = createConnection();
      const client = new AcpAgentClient(connection, { scopeName: 'test' });
      const notify = vi.fn();
      const prompt = client.prompt(
        'session-1',
        [{ type: 'text', text: 'work' }],
        vi.fn(),
        undefined,
        notify,
      );
      const rejected = expect(prompt).rejects.toBeDefined();
      await vi.waitFor(() => expect(connection.send).toHaveBeenCalled());
      expect(client.hasPendingPermissions('session-1')).toBe(false);
      const receive = vi.mocked(connection.onMessage).mock.calls[0][0];
      receive({
        jsonrpc: '2.0',
        id: 'approval-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write file',
            kind: 'edit',
            status: 'pending',
          },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      expect(client.hasPendingPermissions('session-1')).toBe(true);
      expect(client.hasPendingPermissions('other-session')).toBe(false);
      if (finish === 'answer') {
        expect(
          client.resolvePermission(notify.mock.calls[0][0].requestId, {
            optionId: 'allow',
          }),
        ).toBe(true);
        expect(client.hasPendingPermissions('session-1')).toBe(false);
      }
      emitLifecycle({ type: 'agent/disconnected', reason: 'websocket_closed' });
      await rejected;
      expect(client.hasPendingPermissions('session-1')).toBe(false);
    },
  );
  it.each([undefined, {}, { image: false }, { image: 'true' }])(
    'rejects images before sending when image capability is not explicitly true: %j',
    async (promptCapabilities) => {
      const { connection, emitLifecycle } = createConnection();
      const client = new AcpAgentClient(connection, { scopeName: 'test' });
      client.seedFromRecord({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities },
      });
      await expect(
        client.prompt(
          'session-1',
          [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
          vi.fn(),
        ),
      ).rejects.toThrow('does not advertise ACP image input support');
      expect(connection.send).not.toHaveBeenCalled();
      emitLifecycle({ type: 'agent/disconnected', reason: 'websocket_closed' });
    },
  );

  it('passes image content blocks intact when image capability is advertised', async () => {
    const { connection, emitLifecycle } = createConnection();
    const client = new AcpAgentClient(connection, { scopeName: 'test' });
    client.seedFromRecord({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
    });
    const blocks = [
      { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' },
    ];
    const prompt = client.prompt('session-1', blocks, vi.fn());
    const rejected = expect(prompt).rejects.toBeDefined();
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalled());
    expect(connection.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session/prompt',
        params: { sessionId: 'session-1', prompt: blocks },
      }),
    );
    emitLifecycle({ type: 'agent/disconnected', reason: 'websocket_closed' });
    await rejected;
  });
  it('rejects an in-flight prompt and closes the client when the session is suspended', async () => {
    const { connection, emitLifecycle } = createConnection();
    const client = new AcpAgentClient(connection, { scopeName: 'test' });
    const prompt = client.prompt(
      'session-1',
      [{ type: 'text', text: 'work' }],
      vi.fn(),
    );

    emitLifecycle({
      type: 'agent/suspended',
      sessionId: 'session-1',
      reason: 'idle_timeout',
    });

    await expect(prompt).rejects.toBeDefined();
    expect(client.isClosed).toBe(true);
    await expect(
      client.prompt('session-1', [{ type: 'text', text: 'retry' }], vi.fn()),
    ).rejects.toThrow('AcpAgentClient is closed');
  });

  it('closes the client when the session transport disconnects', () => {
    const { connection, emitLifecycle } = createConnection();
    const client = new AcpAgentClient(connection, { scopeName: 'test' });

    emitLifecycle({
      type: 'agent/disconnected',
      reason: 'websocket_closed',
    });

    expect(client.isClosed).toBe(true);
  });
});
