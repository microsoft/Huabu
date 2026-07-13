import { describe, expect, it, vi } from 'vitest';

import { replayEventStoreMeta } from './session.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { AcpSessionLogger } from './session.js';

function logger(): AcpSessionLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('ACP bootstrap metadata replay', () => {
  it('replays early agent session/update events after the client attaches', () => {
    const entry = {
      sessionId: 'native-bootstrap',
      availableCommands: [],
      commandsUpdatedAt: 0,
      availableModes: [],
      currentModeId: null,
      availableModels: [],
      currentModelId: null,
      configOptions: [],
      sessionInfo: null,
      usage: null,
      metaUpdatedAt: 0,
    } as unknown as AcpSessionEntry;
    const testLogger = logger();
    const server = {
      getEventStore: () => ({
        getEventsSince: () => [
          {
            seq: 1,
            ts: new Date(0).toISOString(),
            dir: 'host',
            event: {
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'available_commands_update',
                  availableCommands: [{ name: 'ignored', description: '' }],
                },
              },
            },
          },
          {
            seq: 2,
            ts: new Date(0).toISOString(),
            dir: 'agent',
            event: {
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
            },
          },
        ],
      }),
    } as unknown as Parameters<typeof replayEventStoreMeta>[0];

    replayEventStoreMeta(server, 'native-bootstrap', entry, testLogger);

    expect(entry.availableCommands).toEqual([
      {
        name: 'review',
        description: 'Review changes',
        input: null,
      },
    ]);
    expect(testLogger.info).toHaveBeenCalledWith(
      { sessionId: 'native-bootstrap', replayed: 1 },
      '[acp] replayed session/update events from EventStore for meta seeding',
    );
  });
});
