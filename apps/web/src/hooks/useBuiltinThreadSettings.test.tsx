// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectThreadSettings, useChatStore } from '@/store/chatStore';

import { useBuiltinThreadSettings } from './useBuiltinThreadSettings';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  getModels: vi.fn(async () => []),
  getSettings: vi.fn(),
}));

vi.mock('@/api/llm', () => ({
  getLLMModels: apiMocks.getModels,
  getChatThreadSettings: apiMocks.getSettings,
  setChatThreadModel: vi.fn(),
  setChatThreadReasoningEffort: vi.fn(),
}));

const THREAD_ID = 'thread-idle';
let settingsSeenAfterSelection:
  | { modelId: string | null; reasoningEffort: string | null }
  | undefined;

function Harness({
  threadHasMessages = false,
}: {
  threadHasMessages?: boolean;
}) {
  const { settings, selectModel, selectReasoningEffort } =
    useBuiltinThreadSettings({
      threadId: THREAD_ID,
      canvasId: 'canvas-1',
      provider: 'test-provider',
      defaultModelId: 'default-model',
      enabled: true,
      threadHasMessages,
    });
  return (
    <>
      <span data-testid="settings">
        {settings.modelId}:{settings.reasoningEffort}
      </span>
      <button
        type="button"
        onClick={async () => {
          await selectReasoningEffort('medium');
          settingsSeenAfterSelection = selectThreadSettings(
            useChatStore.getState(),
            THREAD_ID,
          );
        }}
      >
        Select medium
      </button>
      <button
        type="button"
        data-testid="select-model-and-effort"
        onClick={() => {
          void selectModel('model-2');
          void selectReasoningEffort('medium');
          settingsSeenAfterSelection = selectThreadSettings(
            useChatStore.getState(),
            THREAD_ID,
          );
        }}
      >
        Select model and effort
      </button>
    </>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  settingsSeenAfterSelection = undefined;
  apiMocks.getModels.mockClear();
  apiMocks.getSettings.mockReset();
  apiMocks.getSettings.mockRejectedValue(new Error('Thread not found'));
  useChatStore.setState({
    threadsById: {},
    settingsByThread: {
      [THREAD_ID]: { modelId: 'model-1', reasoningEffort: 'high' },
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('useBuiltinThreadSettings', () => {
  it('keeps persisted settings for an idle thread with no server record', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="settings"]')?.textContent,
    ).toBe('model-1:high');
    expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
    expect(apiMocks.getSettings).not.toHaveBeenCalled();
  });

  it('updates the send-path cache before a pre-first-message selection returns', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    await act(async () => {
      container?.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(settingsSeenAfterSelection).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'medium',
    });
  });

  it('preserves consecutive selections made before React re-renders', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="select-model-and-effort"]',
        )
        ?.click();
    });

    expect(settingsSeenAfterSelection).toEqual({
      modelId: 'model-2',
      reasoningEffort: 'medium',
    });
  });

  it('does not reload settings when the first message is sent', async () => {
    apiMocks.getSettings.mockResolvedValue({
      modelId: null,
      reasoningEffort: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      container?.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(<Harness threadHasMessages />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.getSettings).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="settings"]')?.textContent,
    ).toBe('model-1:medium');
    expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'medium',
    });
  });

  it('loads server settings when an established conversation is mounted', async () => {
    apiMocks.getSettings.mockResolvedValue({
      modelId: 'server-model',
      reasoningEffort: 'low',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness threadHasMessages />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.getSettings).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="settings"]')?.textContent,
    ).toBe('server-model:low');
  });
});
