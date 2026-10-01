// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRuntimeConfig, updateRuntimeConfig, toast } = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  updateRuntimeConfig: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/api/acp', () => ({
  getExternalAgentRuntimeConfig: getRuntimeConfig,
  updateExternalAgentRuntimeConfig: updateRuntimeConfig,
}));
vi.mock('@/components/Common/Toast', () => ({ toast }));

import { ExternalAgentRuntimeSettings } from './ExternalAgentRuntimeSettings';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  getRuntimeConfig.mockResolvedValue({
    idleTimeoutSecs: 600,
    maxAgents: 10,
  });
  updateRuntimeConfig.mockResolvedValue({
    idleTimeoutSecs: 1800,
    maxAgents: 10,
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

describe('ExternalAgentRuntimeSettings', () => {
  it('preserves the process limit when saving the idle timeout', async () => {
    await act(async () => {
      root.render(<ExternalAgentRuntimeSettings />);
    });

    const idleTimeout = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('settings.tenMinutesDefault'),
    );
    if (!idleTimeout) throw new Error('Idle-timeout selector not found');

    await act(async () => {
      idleTimeout.click();
    });

    const thirtyMinutes = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'settings.thirtyMinutes',
    );
    if (!thirtyMinutes) throw new Error('Thirty-minute option not found');

    await act(async () => {
      thirtyMinutes.click();
    });

    expect(updateRuntimeConfig).toHaveBeenCalledWith({
      idleTimeoutSecs: 1800,
      maxAgents: 10,
    });
    expect(toast).toHaveBeenCalledWith(
      'settings.externalAgentIdleTimeoutSaved',
      { tone: 'success' },
    );
  });
});
