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
