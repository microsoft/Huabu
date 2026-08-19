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

function Harness() {
  const { settings } = useBuiltinThreadSettings({
    threadId: THREAD_ID,
    canvasId: 'canvas-1',
    provider: 'test-provider',
    defaultModelId: 'default-model',
    enabled: true,
    threadHasMessages: false,
  });
  return (
    <span>
      {settings.modelId}:{settings.reasoningEffort}
    </span>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
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

    expect(container.textContent).toBe('model-1:high');
    expect(selectThreadSettings(useChatStore.getState(), THREAD_ID)).toEqual({
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
    expect(apiMocks.getSettings).not.toHaveBeenCalled();
  });
});
