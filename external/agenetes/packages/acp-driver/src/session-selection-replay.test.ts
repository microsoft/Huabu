import { describe, expect, it, vi } from 'vitest';

import {
  hydrateSelectionsFromPersistedMeta,
  reconcileSessionSelections,
} from './session.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { AcpSessionLogger } from './session.js';
import type { AgentMetadata } from '@agenetes/protocol';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as AcpSessionLogger;

function client() {
  return {
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    setSessionModel: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
  };
}

function entry(overrides: Partial<AcpSessionEntry> = {}): AcpSessionEntry {
  return {
    agentletId: 'agentlet-1',
    threadId: 'thread-1',
    sessionId: 'session_1',
    client: client(),
    availableModes: [],
    currentModeId: null,
    availableModels: [],
    currentModelId: null,
    configOptions: [],
    selections: {},
    selectionsUpdatedAt: 0,
    metaUpdatedAt: 0,
    ...overrides,
  } as unknown as AcpSessionEntry;
}

function configOption(id: string, currentValue: string | boolean) {
  return {
    id,
    name: id,
    category: id,
    type: 'select',
    currentValue,
    options: [],
  };
}

describe('selection hydration', () => {
  it('restores selections even after the agent already pushed meta', () => {
    // `metaUpdatedAt !== 0` is the state the bootstrap `config_option_update`
    // leaves behind; the gated meta hydrate skips it, this one must not.
    const e = entry({ metaUpdatedAt: 1_700_000_000_000 });
    const meta: AgentMetadata = {
      selections: { model: 'claude-opus-4.8', allow_all: 'on' },
      selectionsUpdatedAt: 42,
    };

    hydrateSelectionsFromPersistedMeta(e, meta);

    expect(e.selections).toEqual({
      model: 'claude-opus-4.8',
      allow_all: 'on',
    });
    expect(e.selectionsUpdatedAt).toBe(42);
  });

  it('leaves the agent-reported fields alone so replay can still diff', () => {
    const e = entry({ currentModelId: 'gpt-5.6-sol' });

    hydrateSelectionsFromPersistedMeta(e, {
      selections: { model: 'claude-opus-4.8' },
    });

    expect(e.currentModelId).toBe('gpt-5.6-sol');
  });

  it('is a no-op when the snapshot carries no selections', () => {
    const e = entry({ selections: { model: 'a' }, selectionsUpdatedAt: 7 });

    hydrateSelectionsFromPersistedMeta(e, { currentModelId: 'b' });

    expect(e.selections).toEqual({ model: 'a' });
    expect(e.selectionsUpdatedAt).toBe(7);
  });
});

describe('selection replay', () => {
  it('pushes remembered values the agent disagrees with', async () => {
    const e = entry({
      configOptions: [
        configOption('model', 'gpt-5.6-sol'),
        configOption('allow_all', 'off'),
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { model: 'claude-opus-4.8', allow_all: 'on' },
    });

    await reconcileSessionSelections(e, logger);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption.mock.calls).toEqual([
      ['session_1', 'model', 'claude-opus-4.8'],
      ['session_1', 'allow_all', 'on'],
    ]);
  });

  it('skips knobs the agent already agrees with', async () => {
    const e = entry({
      configOptions: [
        configOption('allow_all', 'on'),
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { allow_all: 'on' },
    });

    await reconcileSessionSelections(e, logger);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('falls back to the legacy channel when no config option publishes the knob', async () => {
    const e = entry({
      selections: { model: 'claude-opus-4.8', mode: 'plan' },
    });

    await reconcileSessionSelections(e, logger);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionModel).toHaveBeenCalledWith(
      'session_1',
      'claude-opus-4.8',
    );
    expect(c.setSessionMode).toHaveBeenCalledWith('session_1', 'plan');
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('drops a selection the agent rejects instead of retrying it forever', async () => {
    const e = entry({ selections: { model: 'retired-model', mode: 'plan' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionModel.mockRejectedValue(new Error('unknown model'));

    await reconcileSessionSelections(e, logger);

    expect(e.selections).toEqual({ mode: 'plan' });
    expect(c.setSessionMode).toHaveBeenCalledWith('session_1', 'plan');
  });

  it('does nothing when there is no remembered intent', async () => {
    const e = entry();

    await reconcileSessionSelections(e, logger);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
    expect(e.metaUpdatedAt).toBe(0);
  });
});
