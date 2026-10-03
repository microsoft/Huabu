// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createConnectionCommand,
  getConnectionTokenConfig,
  getRuntimeConfig,
  updateConnectionToken,
  updateRuntimeConfig,
  toast,
} = vi.hoisted(() => ({
  createConnectionCommand: vi.fn(),
  getConnectionTokenConfig: vi.fn(),
  getRuntimeConfig: vi.fn(),
  updateConnectionToken: vi.fn(),
  updateRuntimeConfig: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/api/acp', () => ({
  createAgentletConnectionCommand: createConnectionCommand,
  getConnectionTokenConfig,
  getExternalAgentRuntimeConfig: getRuntimeConfig,
  updateConnectionToken,
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
  getConnectionTokenConfig.mockResolvedValue({
    source: 'stored',
    writable: true,
  });
  updateConnectionToken.mockResolvedValue({
    source: 'stored',
    writable: true,
  });
  createConnectionCommand.mockResolvedValue({
    command:
      "agentlet daemon --server 'wss://huabu.example/api/acp/agent' --max-agents 10 --token 'secret'",
    warnings: [],
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
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

  it('does not render the active token and saves a replacement', async () => {
    await act(async () => {
      root.render(<ExternalAgentRuntimeSettings />);
    });

    expect(container.textContent).not.toContain('secret');
    const tokenInput = container.querySelector<HTMLInputElement>(
      '#agentlet-connection-token',
    );
    if (!tokenInput) throw new Error('Connection token input not found');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(tokenInput, 'replacement-token');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [
      ...(tokenInput.parentElement?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent === 'settings.saveChanges');
    if (!saveButton) throw new Error('Connection token save button not found');
    await act(async () => {
      saveButton.click();
    });

    expect(updateConnectionToken).toHaveBeenCalledWith({
      token: 'replacement-token',
    });
    expect(container.textContent).not.toContain('replacement-token');
  });

  it('copies the generated command directly without rendering it', async () => {
    await act(async () => {
      root.render(<ExternalAgentRuntimeSettings />);
    });

    const copyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'settings.agentletCommandCopy',
    );
    if (!copyButton) throw new Error('Copy command button not found');
    await act(async () => {
      copyButton.click();
    });

    expect(createConnectionCommand).toHaveBeenCalledOnce();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('wss://huabu.example/api/acp/agent'),
    );
    expect(container.textContent).not.toContain('wss://huabu.example');
    expect(toast).toHaveBeenCalledWith('settings.agentletCommandCopied', {
      tone: 'success',
    });
  });

  it('clears only the stored override', async () => {
    await act(async () => {
      root.render(<ExternalAgentRuntimeSettings />);
    });

    const clearButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'settings.agentletTokenClear',
    );
    if (!clearButton) throw new Error('Clear token button not found');
    await act(async () => {
      clearButton.click();
    });

    expect(updateConnectionToken).toHaveBeenCalledWith({ token: null });
  });
});
