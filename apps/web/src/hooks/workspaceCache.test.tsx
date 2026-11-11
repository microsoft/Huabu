// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { useAcpSessionMeta } from './useAcpSessionMeta';
import { useAcpSlashCommands } from './useAcpSlashCommands';
import { useBuiltinThreadSettings } from './useBuiltinThreadSettings';
import { useInternalSlashCommands } from './useInternalSlashCommands';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  meta: vi.fn(),
  models: vi.fn(),
  settings: vi.fn(),
  skills: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  getAcpThreadCachedMeta: api.meta,
  loadAcpProfileCapabilities: vi.fn(),
}));
vi.mock('@/hooks/useAgentStream', () => ({
  registerAcpSessionMetaSink: () => () => {},
}));
vi.mock('@/api/llm', () => ({
  getLLMModels: api.models,
  getChatThreadSettings: api.settings,
  setChatThreadModel: vi.fn(),
  setChatThreadReasoningEffort: vi.fn(),
}));
vi.mock('@/api/skills', () => ({ listSkills: api.skills }));

function response(label: string) {
  return {
    source: 'thread',
    availableCommands: [{ name: label }],
    sessionMeta: {
      availableModes: [],
      currentModeId: null,
      availableModels: [],
      currentModelId: label,
      configOptions: [],
      selections: {},
      sessionInfo: null,
      usage: null,
      updatedAt: 1,
    },
  };
}

function respondWith(
  label: string,
  pending: Promise<void> = Promise.resolve(),
) {
  api.meta.mockImplementation(async () => {
    await pending;
    return response(label);
  });
  api.models.mockImplementation(async () => {
    await pending;
    return [{ id: label }];
  });
  api.settings.mockImplementation(async () => {
    await pending;
    return { modelId: label, reasoningEffort: null };
  });
  api.skills.mockImplementation(async () => {
    await pending;
    return { skills: [{ id: label, description: label }] };
  });
}

const renders: boolean[] = [];

function Harness() {
  const external = {
    threadId: 'external-thread',
    canvasId: 'canvas',
    binding: {
      kind: 'external' as const,
      profileId: 'profile',
      alias: 'Agent',
    },
  };
  const meta = useAcpSessionMeta(external);
  const commands = useAcpSlashCommands(external);
  const skills = useInternalSlashCommands({ binding: { kind: 'internal' } });
  const builtin = useBuiltinThreadSettings({
    threadId: 'internal-thread',
    canvasId: 'canvas',
    provider: 'provider',
    defaultModelId: null,
    enabled: true,
    threadHasMessages: true,
  });
  renders.push(
    meta.loading || commands.loading || skills.loading || builtin.loading,
  );
  return (
    <div>
      {[
        meta.meta.currentModelId,
        commands.commands[0]?.name,
        skills.commands[0]?.name,
        builtin.models[0]?.id,
        builtin.settings.modelId,
      ].join(',')}
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;

async function render(mode: 'visible' | 'hidden' = 'visible') {
  await act(async () =>
    root.render(
      <Activity mode={mode}>
        <Harness />
      </Activity>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ workspaceId: 'first', workspacePath: '/first' });
  useChatStore.setState({ threadsById: {}, settingsByThread: {} });
  respondWith('first');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useWorkspaceStore.setState({ workspaceId: null, workspacePath: null });
  vi.restoreAllMocks();
});

describe('Workspace-scoped conversation caches', () => {
  it.each(['hide', 'remount'])(
    'retains warm caches across %s without loading',
    async (mode) => {
      await render();
      if (mode === 'hide') await render('hidden');
      else {
        act(() => root.unmount());
        root = createRoot(container);
      }
      renders.length = 0;
      await render();
      expect(container.textContent).toBe('first,first,first,first,first');
      expect(renders).not.toContain(true);
      expect(api.meta).toHaveBeenCalledTimes(2);
      expect(api.models).toHaveBeenCalledOnce();
      expect(api.settings).toHaveBeenCalledOnce();
      expect(api.skills).toHaveBeenCalledOnce();
    },
  );

  it('keeps stale data visible during background refresh after Activity reactivation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    await render();
    await render('hidden');
    now.mockReturnValue(61_000);
    let finish!: () => void;
    respondWith(
      'updated',
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renders.length = 0;
    await render();
    expect(container.textContent).toBe('first,first,first,first,first');
    expect(renders).not.toContain(true);
    await act(async () => finish());
    expect(container.textContent).toBe(
      'updated,updated,updated,updated,updated',
    );
  });

  it.each(['workspaceId', 'workspacePath'] as const)(
    'invalidates every cache on %s changes even while unmounted',
    async (field) => {
      await render();
      act(() => root.unmount());
      respondWith('second');
      useWorkspaceStore.setState({ [field]: 'second' });
      root = createRoot(container);
      await render();
      expect(container.textContent).toBe('second,second,second,second,second');
      expect(api.meta).toHaveBeenCalledTimes(4);
      expect(api.models).toHaveBeenCalledTimes(2);
      expect(api.settings).toHaveBeenCalledTimes(2);
      expect(api.skills).toHaveBeenCalledTimes(2);
    },
  );

  it('discards late results after switching away and back before effects rerun', async () => {
    let finish!: () => void;
    respondWith(
      'obsolete',
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    respondWith('current');
    await act(async () => {
      useWorkspaceStore.setState({ workspaceId: 'second' });
      useWorkspaceStore.setState({ workspaceId: 'first' });
      finish();
      await Promise.resolve();
    });
    expect(container.textContent).toBe(
      'current,current,current,current,current',
    );
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toBe(
      'current,current,current,current,current',
    );
    expect(
      useChatStore.getState().settingsByThread['internal-thread']?.modelId,
    ).toBe('current');
  });
});
