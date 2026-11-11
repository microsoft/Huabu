// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/store/chatStore';
import {
  beginConversationRealization,
  resolveConversationPreparation,
  useConversationPreparationStore,
} from '@/store/conversationPreparation';

import {
  clearAcpSessionMetaCache,
  useAcpSessionMeta,
} from './useAcpSessionMeta';

const apiMocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  loadProfile: vi.fn(),
  sink: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  getAcpThreadCachedMeta: apiMocks.getCached,
  loadAcpProfileCapabilities: apiMocks.loadProfile,
}));

vi.mock('@/hooks/useAgentStream', () => ({
  registerAcpSessionMetaSink: apiMocks.sink,
}));

const EMPTY_META = {
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [],
  selections: {},
  sessionInfo: null,
  usage: null,
  updatedAt: 0,
};

const session = {
  threadId: 'thread-1',
  canvasId: 'canvas-1',
  ownerCanvasId: 'canvas-1',
  conversationView: null,
};
const preparationKey = '["canvas-1","thread-1"]';

function Harness({ profileId = 'profile-1' }: { profileId?: string }) {
  const { loading, source, meta, error, refresh } = useAcpSessionMeta({
    threadId: 'thread-1',
    binding: {
      kind: 'external',
      profileId,
      alias: 'Profile',
    },
    canvasId: 'canvas-1',
  });
  return (
    <button data-updated-at={meta.updatedAt} onClick={() => void refresh()}>
      {loading
        ? 'loading'
        : (error?.message ?? `${source}:${meta.configOptions.length}`)}
    </button>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  apiMocks.getCached.mockReset();
  apiMocks.loadProfile.mockReset();
  apiMocks.sink.mockReset();
  clearAcpSessionMetaCache();
  useChatStore.setState({ threadsById: {}, bindingByThread: {} });
  useConversationPreparationStore.setState({
    directories: {},
    executions: {},
    pending: {},
    queuedControls: {},
    locked: {},
    revisions: {},
  });
});

async function renderHarness(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAcpSessionMeta', () => {
  it.each([undefined, true])(
    'records an unrealized draft before failed discovery and allows retry (prior lock=%s)',
    async (locked) => {
      useChatStore.setState({
        bindingByThread: {
          'thread-1': {
            kind: 'external',
            profileId: 'profile-1',
            alias: 'Profile',
          },
        },
      });
      if (locked !== undefined) {
        useConversationPreparationStore.setState({
          locked: { [preparationKey]: locked },
        });
      }
      apiMocks.getCached.mockResolvedValue({
        source: 'none',
        sessionMeta: EMPTY_META,
      });
      apiMocks.loadProfile
        .mockRejectedValueOnce(new Error('Login required'))
        .mockResolvedValueOnce({
          source: 'profile',
          sessionMeta: { ...EMPTY_META, updatedAt: 1 },
        });
      await renderHarness();
      expect(container?.textContent).toBe('Login required');
      expect(resolveConversationPreparation(session)).toMatchObject({
        editable: true,
        realized: false,
      });
      await act(async () => container?.querySelector('button')?.click());
      expect(container?.textContent).toBe('profile:0');
      expect(apiMocks.loadProfile).toHaveBeenCalledTimes(2);
      expect(useConversationPreparationStore.getState().executions).toEqual({});
    },
  );

  it('does not let discovery completion unlock a newer realization', async () => {
    let finish!: (value: {
      source: 'profile';
      sessionMeta: typeof EMPTY_META;
    }) => void;
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      sessionMeta: EMPTY_META,
    });
    apiMocks.loadProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderHarness();
    expect(
      useConversationPreparationStore.getState().locked[preparationKey],
    ).toBe(false);
    const release = beginConversationRealization(session);
    release();
    await act(async () =>
      finish({
        source: 'profile',
        sessionMeta: { ...EMPTY_META, updatedAt: 1 },
      }),
    );
    expect(
      useConversationPreparationStore.getState().locked[preparationKey],
    ).toBe(true);
  });

  it('does not let an older cache response unlock a newer realization', async () => {
    let finish!: (value: {
      source: 'none';
      sessionMeta: typeof EMPTY_META;
    }) => void;
    apiMocks.getCached.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    apiMocks.loadProfile.mockRejectedValueOnce(new Error('Agentlet offline'));
    await renderHarness();
    const release = beginConversationRealization(session);
    release();
    await act(async () => finish({ source: 'none', sessionMeta: EMPTY_META }));
    expect(container?.textContent).toBe('Agentlet offline');
    expect(
      useConversationPreparationStore.getState().locked[preparationKey],
    ).toBe(true);
  });

  it('keeps the lock unchanged when the execution lookup itself fails', async () => {
    useConversationPreparationStore.setState({
      locked: { [preparationKey]: true },
    });
    apiMocks.getCached.mockRejectedValueOnce(new Error('Cache unavailable'));
    await renderHarness();
    expect(container?.textContent).toBe('Cache unavailable');
    expect(apiMocks.loadProfile).not.toHaveBeenCalled();
    expect(
      useConversationPreparationStore.getState().locked[preparationKey],
    ).toBe(true);
  });

  it('ignores discovery from a previous Profile', async () => {
    let finish!: (value: {
      source: 'profile';
      sessionMeta: typeof EMPTY_META;
    }) => void;
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      sessionMeta: EMPTY_META,
    });
    apiMocks.loadProfile
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({
        source: 'profile',
        sessionMeta: { ...EMPTY_META, updatedAt: 2 },
      });
    await renderHarness();
    await act(async () => root?.render(<Harness profileId="profile-2" />));
    await act(async () =>
      finish({
        source: 'profile',
        sessionMeta: { ...EMPTY_META, updatedAt: 1 },
      }),
    );
    expect(container?.textContent).toBe('profile:0');
    expect(container?.querySelector('button')?.dataset.updatedAt).toBe('2');
    expect(apiMocks.loadProfile).toHaveBeenLastCalledWith('profile-2');
    expect(useConversationPreparationStore.getState().executions).toEqual({});
  });

  it('keeps live thread metadata authoritative over an in-flight discovery', async () => {
    let finish!: (value: {
      source: 'profile';
      sessionMeta: typeof EMPTY_META;
    }) => void;
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      sessionMeta: EMPTY_META,
    });
    apiMocks.loadProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderHarness();
    const applyEvent = apiMocks.sink.mock.calls[0][1];
    await act(async () =>
      applyEvent({
        type: 'session_mode_update',
        data: {
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      }),
    );
    await act(async () =>
      finish({
        source: 'profile',
        sessionMeta: { ...EMPTY_META, updatedAt: 1 },
      }),
    );
    expect(container?.textContent).toBe('thread:0');
  });
  it('hydrates frozen directory facts and refreshes them after a streamed turn', async () => {
    const execution = {
      binding: {
        kind: 'external' as const,
        profileId: 'profile-1',
        alias: 'Profile',
      },
      workingDirPath: '/frozen/project',
    };
    apiMocks.getCached.mockResolvedValue({
      source: 'thread',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: EMPTY_META,
      execution,
    });
    await renderHarness();
    expect(
      useConversationPreparationStore.getState().executions[
        '["canvas-1","thread-1"]'
      ],
    ).toEqual(execution);
    expect(resolveConversationPreparation(session)).toMatchObject({
      realized: true,
      editable: false,
    });
    expect(apiMocks.loadProfile).not.toHaveBeenCalled();
    await act(async () => {
      useChatStore.getState().setThreadLoading('thread-1', true);
    });
    await act(async () => {
      useChatStore.getState().setThreadLoading('thread-1', false);
    });
    expect(apiMocks.getCached).toHaveBeenCalledTimes(2);
  });
  it('automatically discovers a cold Profile without realizing the conversation', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: EMPTY_META,
    });
    apiMocks.loadProfile.mockResolvedValue({
      source: 'profile',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: { ...EMPTY_META, updatedAt: 1 },
    });

    await renderHarness();
    expect(apiMocks.getCached).toHaveBeenCalledOnce();
    expect(apiMocks.loadProfile).toHaveBeenCalledExactlyOnceWith('profile-1');
    expect(container?.textContent).toBe('profile:0');
    expect(useConversationPreparationStore.getState().executions).toEqual({});
    expect(
      Object.values(useConversationPreparationStore.getState().locked),
    ).not.toContain(true);
  });

  it('renders a Profile capability observation without warming a thread', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'profile',
      availableCommands: [{ name: 'help', description: 'Help' }],
      commandsUpdatedAt: 1,
      sessionMeta: {
        ...EMPTY_META,
        currentModelId: 'model-1',
        configOptions: [
          {
            id: 'allow_all',
            name: 'Auto approve',
            type: 'boolean',
            currentValue: true,
          },
        ],
        updatedAt: 1,
      },
    });

    await renderHarness();

    expect(apiMocks.getCached).toHaveBeenCalledWith(
      'thread-1',
      'canvas-1',
      'profile-1',
    );
    expect(container?.textContent).toBe('profile:1');
    expect(apiMocks.loadProfile).not.toHaveBeenCalled();
  });

  it('retains cached session metadata across unmount and remount without re-entering loading', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'thread',
      availableCommands: [],
      commandsUpdatedAt: 1,
      sessionMeta: {
        ...EMPTY_META,
        currentModelId: 'model-1',
        configOptions: [
          {
            id: 'allow_all',
            name: 'Auto approve',
            type: 'boolean',
            currentValue: true,
          },
        ],
        updatedAt: 1,
      },
    });

    await renderHarness();
    expect(container?.textContent).toBe('thread:1');
    expect(apiMocks.getCached).toHaveBeenCalledOnce();

    act(() => root?.unmount());
    container?.remove();

    await renderHarness();
    expect(container?.textContent).toBe('thread:1');
    expect(apiMocks.getCached).toHaveBeenCalledOnce();
  });
});
