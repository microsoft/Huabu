import { describe, expect, it } from 'vitest';

import {
  MODEL_SELECTION_ID,
  MODE_SELECTION_ID,
  recordSessionSelection,
  snapshotEntryState,
} from './session.js';

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
    selections: {},
    selectionsUpdatedAt: 0,
    sessionInfo: null,
    usage: null,
    metaUpdatedAt: 0,
    ...overrides,
  } as unknown as AcpSessionEntry;
}

describe('ACP durable state snapshot', () => {
  it('persists preamble delivery independently from sessionId', () => {
    expect(snapshotEntryState(entry())).toMatchObject({
      driverState: {
        sessionId: 'session_1',
        initialPreambleDelivered: false,
      },
    });

    expect(
      snapshotEntryState(
        entry({
          persistedToDisk: false,
          initialPreambleDelivered: true,
        }),
      ),
    ).toMatchObject({
      driverState: { initialPreambleDelivered: true },
    });
    expect(
      snapshotEntryState(
        entry({
          persistedToDisk: false,
          initialPreambleDelivered: true,
        }),
      ),
    ).not.toHaveProperty('driverState.sessionId');
  });
});

describe('per-thread selections', () => {
  it('mirrors reserved ids onto their legacy dedicated fields', () => {
    const e = entry();
    recordSessionSelection(e, MODEL_SELECTION_ID, 'claude-opus-4.8');
    recordSessionSelection(e, MODE_SELECTION_ID, 'plan');
    recordSessionSelection(e, 'allow_all', 'on');

    expect(e.selections).toEqual({
      model: 'claude-opus-4.8',
      mode: 'plan',
      allow_all: 'on',
    });
    expect(e.currentModelId).toBe('claude-opus-4.8');
    expect(e.currentModeId).toBe('plan');
    expect(e.selectionsUpdatedAt).toBeGreaterThan(0);
  });

  it('carries selections into the durable metadata snapshot', () => {
    const e = entry();
    recordSessionSelection(e, 'allow_all', true);

    expect(snapshotEntryState(e).metadata).toMatchObject({
      selections: { allow_all: true },
      selectionsUpdatedAt: e.selectionsUpdatedAt,
    });
  });

  it('keeps the agent-reported config option separate from the selection', () => {
    const e = entry({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-sol',
          options: [],
        },
      ] as unknown as AcpSessionEntry['configOptions'],
    });
    recordSessionSelection(e, MODEL_SELECTION_ID, 'claude-opus-4.8');

    expect(e.selections.model).toBe('claude-opus-4.8');
    expect(e.configOptions[0]).toMatchObject({ currentValue: 'gpt-5.6-sol' });
  });
});
