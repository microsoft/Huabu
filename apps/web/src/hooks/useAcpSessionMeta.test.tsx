// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAcpSessionMeta } from './useAcpSessionMeta';

const apiMocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  getCached: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  ensureAcpSession: apiMocks.ensure,
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
  sessionInfo: null,
  usage: null,
  updatedAt: 0,
};

function Harness({ autoEnsure }: { autoEnsure: boolean }) {
  const { loading, error } = useAcpSessionMeta({
    threadId: 'thread-1',
    binding: {
      kind: 'external',
      profileId: 'profile-1',
      alias: 'Profile',
    },
    canvasId: 'canvas-1',
    autoEnsureOnCacheMiss: autoEnsure,
  });
  return <span>{loading ? 'loading' : error ? 'error' : 'idle'}</span>;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  apiMocks.ensure.mockReset();
  apiMocks.getCached.mockReset();
});

async function renderHarness(autoEnsure: boolean): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness autoEnsure={autoEnsure} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAcpSessionMeta', () => {
  it('does not send manifest Profiles through command-session auto-ensure', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      sessionMeta: EMPTY_META,
    });

    await renderHarness(false);

    expect(apiMocks.getCached).toHaveBeenCalledOnce();
    expect(apiMocks.ensure).not.toHaveBeenCalled();
    expect(container?.textContent).toBe('idle');
  });

  it('keeps auto-ensure enabled for command and unknown Profiles', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'none',
      sessionMeta: EMPTY_META,
    });
    apiMocks.ensure.mockResolvedValue({
      sessionMeta: {
        ...EMPTY_META,
        availableModes: [{ id: 'default', name: 'Default' }],
        updatedAt: 1,
      },
    });

    await renderHarness(true);

    expect(apiMocks.ensure).toHaveBeenCalledOnce();
  });

  it('ensures a real command session when only profile defaults are cached', async () => {
    apiMocks.getCached.mockResolvedValue({
      source: 'profile',
      sessionMeta: {
        ...EMPTY_META,
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
    apiMocks.ensure.mockResolvedValue({
      sessionMeta: {
        ...EMPTY_META,
        configOptions: [
          {
            id: 'allow_all',
            name: 'Auto approve',
            type: 'boolean',
            currentValue: false,
          },
        ],
        updatedAt: 2,
      },
    });

    await renderHarness(true);

    expect(apiMocks.ensure).toHaveBeenCalledOnce();
  });
});
