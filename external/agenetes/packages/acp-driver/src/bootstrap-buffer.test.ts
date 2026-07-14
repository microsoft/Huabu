import { describe, expect, it, vi } from 'vitest';

import { AcpAgentClient } from './client.js';

import type { AgentletConnection } from '@agenetes/agentlet-host';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

describe('ACP bootstrap metadata buffering', () => {
  it('delivers an update buffered before the client attaches', async () => {
    const connection: AgentletConnection = {
      sessionId: 'native-bootstrap',
      agentletId: 'machine-a',
      role: 'agent-session',
      metadata: {},
      status: 'connected',
      connectedAt: new Date(0),
      sessionProfile: undefined,
      agentletProfile: undefined,
      send: vi.fn(),
      onMessage: (handler) => {
        handler({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'native-bootstrap',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'review',
                  description: 'Review changes',
                  input: null,
                },
              ],
            },
          },
        });
      },
      onLifecycle: vi.fn(),
      disconnect: vi.fn(),
    };
    const client = new AcpAgentClient(connection, {
      scopeName: 'test',
    });
    const updates: SessionUpdate[] = [];

    client.registerSessionListener('native-bootstrap', (update) => {
      updates.push(update);
    });

    await vi.waitFor(() => {
      expect(updates).toEqual([
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'review',
              description: 'Review changes',
              input: null,
            },
          ],
        },
      ]);
    });
    client.shutdown();
  });
});
