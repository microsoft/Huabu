// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentChangeReviewConfig, updateAgentChangeReviewConfig, toast, t } =
  vi.hoisted(() => ({
    getAgentChangeReviewConfig: vi.fn(),
    updateAgentChangeReviewConfig: vi.fn(),
    toast: vi.fn(),
    t: (key: string) => key,
  }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

vi.mock('@/api/agentChangeReview', () => ({
  getAgentChangeReviewConfig,
  updateAgentChangeReviewConfig,
}));

vi.mock('@/components/Common/Toast', () => ({ toast }));
vi.mock('@/store/chatPreferencesStore', () => ({
  MAX_RECENT_CHAT_TURNS: 20,
  MIN_RECENT_CHAT_TURNS: 1,
  useChatPreferencesStore: (selector: (state: object) => unknown) =>
    selector({
      recentTurnCount: 3,
      setRecentTurnCount: vi.fn(),
    }),
}));
import { AgentBehaviorSettings } from './AgentBehaviorSettings';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  getAgentChangeReviewConfig.mockResolvedValue({
    autoAcceptSpaceChanges: false,
  });
  updateAgentChangeReviewConfig.mockResolvedValue({
    autoAcceptSpaceChanges: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSettings(): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(<AgentBehaviorSettings />);
  });
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="settings.autoAcceptAgentChanges"]',
  );
  expect(toggle).not.toBeNull();
  return toggle as HTMLButtonElement;
}

describe('AgentBehaviorSettings', () => {
  it('loads the server value and persists a toggle', async () => {
    const toggle = await renderSettings();
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      toggle.click();
    });

    expect(updateAgentChangeReviewConfig).toHaveBeenCalledWith({
      autoAcceptSpaceChanges: true,
    });
    expect(
      container
        .querySelector(
          '[role="switch"][aria-label="settings.autoAcceptAgentChanges"]',
        )
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('restores the confirmed value when saving fails', async () => {
    updateAgentChangeReviewConfig.mockRejectedValueOnce(
      new Error('save failed'),
    );
    const toggle = await renderSettings();

    await act(async () => {
      toggle.click();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toast).toHaveBeenCalledWith('save failed', { tone: 'danger' });
  });
});
