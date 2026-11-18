import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_SELECTION_ID,
  MODE_SELECTION_ID,
  recordSessionSelection,
  recordPromptUsage,
  restoreSessionUsage,
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
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  it('replaces reported token snapshots, including a lower value after recovery', () => {
    const e = entry();
    recordPromptUsage(
      e,
      { inputTokens: 3004, outputTokens: 74, totalTokens: 3078 },
      logger,
    );
    const first = snapshotEntryState(e);
    expect(first.metadata?.tokenUsage).toMatchObject({
      inputTokens: 3004,
      outputTokens: 74,
      totalTokens: 3078,
      receivedAt: expect.any(Number),
    });
    recordPromptUsage(
      e,
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      logger,
    );
    expect(e.tokenUsage?.inputTokens).toBe(10);
    expect(first.metadata?.tokenUsage?.inputTokens).toBe(3004);
  });

  it('keeps the previous report and its timestamp when usage is absent or invalid', () => {
    const e = entry();
    recordPromptUsage(
      e,
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      logger,
    );
    const report = e.tokenUsage;
    for (const value of [
      undefined,
      null,
      {},
      { inputTokens: -1, outputTokens: 2, totalTokens: 1 },
      ...[NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(
        (inputTokens) => ({
          inputTokens,
          outputTokens: 2,
          totalTokens: 3,
        }),
      ),
    ]) {
      recordPromptUsage(e, value, logger);
      expect(e.tokenUsage).toBe(report);
    }
    expect(logger.warn).toHaveBeenCalled();
  });

  it('restores same-session usage independently of config updates, never to a replacement session', () => {
    const prior = snapshotEntryState(
      entry({
        usage: { used: 100, size: 1000, cost: null, receivedAt: 123 },
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 30,
          totalTokens: 230,
          receivedAt: 124,
        },
      }),
    );
    const resumed = entry({ metaUpdatedAt: 999, tokenUsage: null });
    restoreSessionUsage(resumed, prior);
    expect(resumed.usage?.receivedAt).toBe(123);
    expect(resumed.tokenUsage?.receivedAt).toBe(124);
    const replacement = entry({ sessionId: 'session_2', tokenUsage: null });
    restoreSessionUsage(replacement, prior);
    expect(replacement.usage).toBeNull();
    expect(replacement.tokenUsage).toBeNull();
    const liveUsage = { used: 50, size: 1000, cost: null, receivedAt: 125 };
    resumed.usage = liveUsage;
    restoreSessionUsage(resumed, prior);
    expect(resumed.usage).toBe(liveUsage);
  });

  it('does not persist compiled harness arguments for new executions', () => {
    const launchPlan = {
      version: 1 as const,
      executable: 'copilot',
      argv: ['--acp'],
      env: {},
    };
    const state = snapshotEntryState(
      entry({
        persistedToDisk: false,
        bindingRecipe: {
          launch: { kind: 'acp-harness', harnessId: 'copilot' },
          launchPlan,
          alias: 'Typed',
          autoRestart: true,
        },
      }),
    );
    expect(state.driverState.harnessLaunchPlan).toBeUndefined();
    expect(state.driverState.sessionId).toBeUndefined();
  });

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
