// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAcpSlashCommands } from './useAcpSlashCommands';

const apiMocks = vi.hoisted(() => ({
  getCached: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  getAcpThreadCachedMeta: apiMocks.getCached,
}));

function Harness() {
  const result = useAcpSlashCommands({
    threadId: 'thread-1',
    binding: {
      kind: 'external',
      profileId: 'profile-1',
      alias: 'Profile',
    },
    canvasId: 'canvas-1',
  });
  return (
    <button type="button" onClick={() => result.refreshIfStale(0)}>
      {result.commands.map((command) => command.name).join(',')}
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

describe('useAcpSlashCommands', () => {
  it('hydrates a cold cache with one GET and no polling', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: {
        availableModes: [],
        currentModeId: null,
        availableModels: [],
        currentModelId: null,
        configOptions: [],
        selections: {},
        sessionInfo: null,
        usage: null,
        updatedAt: 0,
      },
    });

    await renderHarness();

    expect(apiMocks.getCached).toHaveBeenCalledOnce();
    expect(container?.textContent).toBe('');
  });

  it('refreshes the GET cache on later slash-menu intent', async () => {
    apiMocks.getCached
      .mockResolvedValueOnce({
        source: 'profile',
        availableCommands: [],
        commandsUpdatedAt: 0,
        sessionMeta: {
          availableModes: [],
          currentModeId: null,
          availableModels: [],
          currentModelId: null,
          configOptions: [],
          selections: {},
          sessionInfo: null,
          usage: null,
          updatedAt: 0,
        },
      })
      .mockResolvedValueOnce({
        source: 'profile',
        availableCommands: [{ name: 'review', description: 'Review' }],
        commandsUpdatedAt: 2,
        sessionMeta: {
          availableModes: [],
          currentModeId: null,
          availableModels: [],
          currentModelId: null,
          configOptions: [],
          selections: {},
          sessionInfo: null,
          usage: null,
          updatedAt: 2,
        },
      });

    await renderHarness();
    await act(async () => {
      container?.querySelector('button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.getCached).toHaveBeenCalledTimes(2);
    expect(apiMocks.getCached).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toBe('review');
  });
});
