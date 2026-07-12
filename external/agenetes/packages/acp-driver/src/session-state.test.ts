import { describe, expect, it } from 'vitest';

import { snapshotEntryState } from './session.js';

import type { AcpSessionEntry } from './session-registry.js';

function entry(overrides: Partial<AcpSessionEntry> = {}): AcpSessionEntry {
  return {
    sessionId: 'session_1',
    persistedToDisk: true,
    initialPreambleDelivered: false,
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
    ...overrides,
  } as unknown as AcpSessionEntry;
}

describe('ACP durable state snapshot', () => {
  it('persists preamble delivery independently from sessionId', () => {
    expect(snapshotEntryState(entry())).toMatchObject({
      sessionId: 'session_1',
      initialPreambleDelivered: false,
    });

    expect(
      snapshotEntryState(
        entry({
          persistedToDisk: false,
          initialPreambleDelivered: true,
        }),
      ),
    ).toMatchObject({
      initialPreambleDelivered: true,
    });
    expect(
      snapshotEntryState(
        entry({
          persistedToDisk: false,
          initialPreambleDelivered: true,
        }),
      ),
    ).not.toHaveProperty('sessionId');
  });
});
