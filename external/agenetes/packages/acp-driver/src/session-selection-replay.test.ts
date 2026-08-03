import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  awaitSelectionReplay,
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
    selectionsReplay: null,
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

/**
 * Most cases below exercise the diffing itself, which only applies when a
 * live agent push established the entry's `current*` view — so that is the
 * default here. The resume case that does NOT have one passes `false`.
 */
const replay = (e: AcpSessionEntry, agentViewIsLive = true) =>
  reconcileSessionSelections(e, logger, { agentViewIsLive });

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

    await replay(e);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption.mock.calls).toEqual([
      ['session_1', 'model', 'claude-opus-4.8'],
      ['session_1', 'allow_all', 'on'],
    ]);
  });

  it('replays even when the restored record mirrors the selection', async () => {
    // The exact state a resume produces. `recordSessionSelection` mirrors a
    // mode pick onto `currentModeId`, and the agent echoes a config-option
    // pick back as `currentValue`; BOTH are persisted, and
    // `hydrateEntryFromPersistedMeta` restores them when no live push
    // beat it. So the agent-reported fields carry a copy of the user's own
    // choice, not the agent's view — the fresh agent is still on its
    // defaults and must be told.
    const e = entry({
      currentModeId: 'agent-full-access',
      configOptions: [
        configOption('allow_all', true),
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { mode: 'agent-full-access', allow_all: true },
    });

    await replay(e, false);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionMode).toHaveBeenCalledWith(
      'session_1',
      'agent-full-access',
    );
    expect(c.setSessionConfigOption).toHaveBeenCalledWith(
      'session_1',
      'allow_all',
      true,
    );
  });

  it('skips knobs a live agent push says it already agrees with', async () => {
    const e = entry({
      configOptions: [
        configOption('allow_all', 'on'),
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { allow_all: 'on' },
    });

    await replay(e);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('falls back to the legacy channel when no config option publishes the knob', async () => {
    const e = entry({
      selections: { model: 'claude-opus-4.8', mode: 'plan' },
    });

    await replay(e);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionModel).toHaveBeenCalledWith(
      'session_1',
      'claude-opus-4.8',
    );
    expect(c.setSessionMode).toHaveBeenCalledWith('session_1', 'plan');
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('drops a selection the agent refuses instead of retrying it forever', async () => {
    const e = entry({ selections: { model: 'retired-model', mode: 'plan' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    // -32602 invalid params: the agent looked at the value and said no.
    c.setSessionModel.mockRejectedValue(
      new RequestError(-32602, 'unknown model'),
    );

    await replay(e);

    expect(e.selections).toEqual({ mode: 'plan' });
    expect(c.setSessionMode).toHaveBeenCalledWith('session_1', 'plan');
  });

  it('drops a selection whose channel the agent no longer implements', async () => {
    const e = entry({ selections: { model: 'claude-opus-4.8' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionModel.mockRejectedValue(
      new RequestError(-32601, 'method not found'),
    );

    await replay(e);

    expect(e.selections).toEqual({});
  });

  it('keeps a selection the agent never got to see', async () => {
    // A dead socket says nothing about the value. Forgetting it here would
    // destroy durable user intent over a transport blip.
    const e = entry({ selections: { model: 'claude-opus-4.8', mode: 'plan' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionModel.mockRejectedValue(new Error('ACP connection closed'));

    await replay(e);

    expect(e.selections).toEqual({ model: 'claude-opus-4.8', mode: 'plan' });
  });

  it('keeps a selection the agent failed to apply internally', async () => {
    // -32603 is a verdict about the call, not about the value.
    const e = entry({ selections: { model: 'claude-opus-4.8' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionModel.mockRejectedValue(
      new RequestError(-32603, 'internal error'),
    );

    await replay(e);

    expect(e.selections).toEqual({ model: 'claude-opus-4.8' });
  });

  it('leaves the record untouched when every replay merely failed to land', async () => {
    const e = entry({ selections: { model: 'claude-opus-4.8' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionModel.mockRejectedValue(new Error('ACP connection closed'));

    await replay(e);

    // Nothing was applied and nothing was dropped, so there is no state
    // change to up-report — the next open retries from the same record.
    expect(e.metaUpdatedAt).toBe(0);
    expect(e.selectionsUpdatedAt).toBe(0);
  });

  it('forgets a legacy selection a config option has taken over', async () => {
    // An agent upgrade that moves model onto the modern channel under its
    // own id: renderers key the takeover off `category`, so the legacy pill
    // vanishes while `selections.model` lingers — invisible, yet replayed
    // through setSessionModel on every open, fighting the pill that
    // replaced it.
    const e = entry({
      configOptions: [
        { ...configOption('model_id', 'gpt-5.6-sol'), category: 'model' },
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { model: 'claude-opus-4.8', model_id: 'gpt-5.6-sol' },
    });

    await replay(e, false);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(e.selections).toEqual({ model_id: 'gpt-5.6-sol' });
    expect(c.setSessionModel).not.toHaveBeenCalled();
  });

  it('keeps a legacy selection the config option addresses under the same id', async () => {
    // `{ id: 'mode', category: 'mode' }` is the same knob reached through the
    // modern channel, not a replacement — the key still names something real.
    const e = entry({
      configOptions: [
        configOption('mode', 'default'),
      ] as unknown as AcpSessionEntry['configOptions'],
      selections: { mode: 'agent-full-access' },
    });

    await replay(e, false);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(e.selections).toEqual({ mode: 'agent-full-access' });
    expect(c.setSessionConfigOption).toHaveBeenCalledWith(
      'session_1',
      'mode',
      'agent-full-access',
    );
  });

  it('pushes the value a set-RPC installed mid-replay, not the stale one', async () => {
    // The wait in `awaitSelectionReplay` is bounded, so a user's set-RPC can
    // overtake a slow replay; a value captured before that click would land
    // behind it and revert the choice.
    const e = entry({ selections: { mode: 'plan', model: 'claude-opus-4.8' } });
    const c = e.client as unknown as ReturnType<typeof client>;
    c.setSessionMode.mockImplementation(async () => {
      e.selections.model = 'gpt-5.6-sol';
    });

    await replay(e);

    expect(c.setSessionModel).toHaveBeenCalledWith('session_1', 'gpt-5.6-sol');
  });

  it('does nothing when there is no remembered intent', async () => {
    const e = entry();

    await replay(e, false);

    const c = e.client as unknown as ReturnType<typeof client>;
    expect(c.setSessionConfigOption).not.toHaveBeenCalled();
    expect(e.metaUpdatedAt).toBe(0);
  });
});

describe('selection replay ordering', () => {
  it('does not wait when no replay is pending', async () => {
    await expect(
      awaitSelectionReplay(entry({ selectionsReplay: null })),
    ).resolves.toBeUndefined();
  });

  it('holds the caller until the replay lands', async () => {
    // The guarantee the first turn of a resumed thread depends on: the
    // prompt must not overtake the knobs it should run under.
    let landed!: () => void;
    const e = entry({
      selectionsReplay: new Promise<void>((resolve) => {
        landed = resolve;
      }),
    });

    let proceeded = false;
    const waiting = awaitSelectionReplay(e).then(() => {
      proceeded = true;
    });
    await Promise.resolve();
    expect(proceeded).toBe(false);

    landed();
    await waiting;
    expect(proceeded).toBe(true);
  });

  it('holds a caller that arrives while another is already waiting', async () => {
    // The overlap `control()` actually hits: run() is holding the prompt on
    // the replay when the user clicks a pill. If the second caller sails
    // past, the remembered value lands behind its set-RPC and reverts the
    // choice the user just made — the exact revert this wait prevents.
    let landed!: () => void;
    const e = entry({
      selectionsReplay: new Promise<void>((resolve) => {
        landed = resolve;
      }),
    });

    let firstDone = false;
    let secondDone = false;
    const first = awaitSelectionReplay(e).then(() => {
      firstDone = true;
    });
    const second = awaitSelectionReplay(e).then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    landed();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  it('gives up after the bound so an unresponsive agent cannot hang the turn', async () => {
    vi.useFakeTimers();
    try {
      const e = entry({ selectionsReplay: new Promise<void>(() => {}) });

      const waiting = awaitSelectionReplay(e);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out the bound at most once per session', async () => {
    vi.useFakeTimers();
    try {
      const e = entry({ selectionsReplay: new Promise<void>(() => {}) });
      const first = awaitSelectionReplay(e);
      await vi.advanceTimersByTimeAsync(3_000);
      await first;

      // Would hang here \u2014 nothing advances the clock again \u2014 if a second
      // caller re-armed the bound instead of proceeding straight through.
      await awaitSelectionReplay(e);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
