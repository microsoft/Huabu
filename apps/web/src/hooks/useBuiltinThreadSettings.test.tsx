// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useEffect } from 'react';
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
  setModel: vi.fn(),
  setEffort: vi.fn(),
}));

vi.mock('@/api/llm', () => ({
  getLLMModels: apiMocks.getModels,
  getChatThreadSettings: apiMocks.getSettings,
  setChatThreadModel: apiMocks.setModel,
  setChatThreadReasoningEffort: apiMocks.setEffort,
}));

const THREAD_ID = 'thread-idle';
let settingsSeenAfterSelection:
  | { modelId: string | null; reasoningEffort: string | null }
  | undefined;
let currentSettings: ReturnType<typeof useBuiltinThreadSettings>;

function Harness({
  threadHasMessages = false,
  threadId = THREAD_ID,
}: {
  threadHasMessages?: boolean;
  threadId?: string;
}) {
  const result = useBuiltinThreadSettings({
    threadId,
    canvasId: 'canvas-1',
    provider: 'test-provider',
    defaultModelId: 'default-model',
    enabled: true,
    threadHasMessages,
  });
  const { settings, selectModel, selectReasoningEffort } = result;
  useEffect(() => {
    currentSettings = result;
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
  apiMocks.setModel.mockReset();
  apiMocks.setEffort.mockReset();
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
  it.each(['model', 'effort'] as const)(
    'optimistically changes %s, rejects overlapping changes, and rolls back on failure',
    async (kind) => {
      let reject!: (error: Error) => void;
      const request = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      (kind === 'model'
        ? apiMocks.setModel
        : apiMocks.setEffort
      ).mockReturnValue(request);
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root?.render(<Harness threadHasMessages />));

      let selection!: Promise<void>;
      await act(async () => {
        selection =
          kind === 'model'
            ? currentSettings.selectModel('model-2')
            : currentSettings.selectReasoningEffort('medium');
      });
      expect(currentSettings.saving).toBe(true);
      expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual(
        kind === 'model'
          ? { modelId: 'model-2', reasoningEffort: null }
          : { modelId: 'model-1', reasoningEffort: 'medium' },
      );
      await expect(currentSettings.selectModel('model-3')).rejects.toThrow();
      await expect(
        currentSettings.selectReasoningEffort('low'),
      ).rejects.toThrow();
      expect(apiMocks.setModel).toHaveBeenCalledTimes(kind === 'model' ? 1 : 0);
      expect(apiMocks.setEffort).toHaveBeenCalledTimes(
        kind === 'effort' ? 1 : 0,
      );
      await act(async () => {
        const rejected = expect(selection).rejects.toThrow('Settings rejected');
        reject(new Error('Settings rejected'));
        await rejected;
      });
      expect(currentSettings.saving).toBe(false);
      expect(currentSettings.settings).toEqual({
        modelId: 'model-1',
        reasoningEffort: 'high',
      });
      expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual(
        currentSettings.settings,
      );
    },
  );

  it('adopts canonical model settings immediately and permits a later update', async () => {
    apiMocks.setModel.mockResolvedValue({
      modelId: 'canonical-model',
      reasoningEffort: 'low',
    });
    apiMocks.setEffort.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness threadHasMessages />));
    await act(async () => {
      await currentSettings.selectModel('model-2');
      expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual({
        modelId: 'canonical-model',
        reasoningEffort: 'low',
      });
    });
    await act(async () => currentSettings.selectReasoningEffort('medium'));
    expect(currentSettings.settings.reasoningEffort).toBe('medium');
    expect(currentSettings.saving).toBe(false);
  });

  it('rolls back the original thread without overwriting a newly viewed thread', async () => {
    let reject!: (error: Error) => void;
    apiMocks.setModel.mockReturnValue(
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
    );
    useChatStore.getState().setThreadSettings('other', {
      modelId: 'other-model',
      reasoningEffort: 'low',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness threadHasMessages />));
    let selection!: Promise<void>;
    await act(async () => {
      selection = currentSettings.selectModel('model-2');
    });
    await act(async () =>
      root?.render(<Harness threadId="other" threadHasMessages />),
    );
    await act(async () => {
      const rejected = expect(selection).rejects.toThrow('Rejected');
      reject(new Error('Rejected'));
      await rejected;
    });
    expect(currentSettings.settings).toEqual({
      modelId: 'other-model',
      reasoningEffort: 'low',
    });
    expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
  });

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
