// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAcpSessionMeta } from './useAcpSessionMeta';

const apiMocks = vi.hoisted(() => ({
  getCached: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  getAcpThreadCachedMeta: apiMocks.getCached,
}));

vi.mock('@/hooks/useAgentStream', () => ({
  registerAcpSessionMetaSink: vi.fn(() => () => {}),
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

function Harness() {
  const { loading, source, meta } = useAcpSessionMeta({
    threadId: 'thread-1',
    binding: {
      kind: 'external',
      profileId: 'profile-1',
      alias: 'Profile',
    },
    canvasId: 'canvas-1',
  });
  return (
    <span>
      {loading ? 'loading' : `${source}:${meta.configOptions.length}`}
    </span>
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
  it('uses a GET-only cold cache result without starting a session', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: EMPTY_META,
    });

    await renderHarness();
    expect(apiMocks.getCached).toHaveBeenCalledOnce();
    expect(apiMocks.getCached).toHaveBeenCalledOnce();
    expect(container?.textContent).toBe('none:0');
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
  });
});
