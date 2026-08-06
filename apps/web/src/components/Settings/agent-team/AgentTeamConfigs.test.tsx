// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTeamConfigs } from './AgentTeamConfigs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const apiMocks = vi.hoisted(() => ({
  updateConfigs: vi.fn(),
}));

vi.mock('@/api/agent-team', () => ({
  updateAgentTeamConfigs: apiMocks.updateConfigs,
}));

vi.mock('@/components/Common/Button', () => ({
  Button: ({
    children,
    variant: _variant,
    tone: _tone,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    tone?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/Common/TextInput', () => ({
  TextInput: ({
    mono: _mono,
    size: _size,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    mono?: boolean;
    size?: 'sm' | 'md';
  }) => <input {...props} />,
}));

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('AgentTeamConfigs', () => {
  it('treats required fields as the unmarked default', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentTeamConfigs
          config={{
            machine: 'machine-id',
            manifestPath: '/team/member/agentlet.yaml',
            fields: [
              {
                name: 'TOKEN',
                description: 'API token',
                required: true,
                secret: true,
                configured: false,
              },
            ],
            missingRequired: ['TOKEN'],
            ready: false,
          }}
          onDetailChange={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('TOKEN');
    expect(container.textContent).not.toContain('(*)');
    expect(container.textContent).not.toContain('missingRequired');
  });

  it('saves a changed non-secret value on blur without a save button', async () => {
    apiMocks.updateConfigs.mockResolvedValue({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      member: {},
      config: {},
      profiles: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentTeamConfigs
          config={{
            machine: 'machine-id',
            manifestPath: '/team/member/agentlet.yaml',
            fields: [
              {
                name: 'MODEL',
                description: 'Model name',
                required: false,
                secret: false,
                configured: true,
                value: 'old-model',
              },
            ],
            missingRequired: [],
            ready: true,
          }}
          onDetailChange={vi.fn()}
        />,
      );
    });

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, 'new-model');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.updateConfigs).toHaveBeenCalledWith({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      values: { MODEL: 'new-model' },
    });
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('clears a non-secret value as null on blur', async () => {
    apiMocks.updateConfigs.mockResolvedValue({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      member: {},
      config: {},
      profiles: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentTeamConfigs
          config={{
            machine: 'machine-id',
            manifestPath: '/team/member/agentlet.yaml',
            fields: [
              {
                name: 'MODEL',
                description: 'Model name',
                required: false,
                secret: false,
                configured: true,
                value: 'old-model',
              },
            ],
            missingRequired: [],
            ready: true,
          }}
          onDetailChange={vi.fn()}
        />,
      );
    });

    const input = container.querySelector('input')!;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, '  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.updateConfigs).toHaveBeenCalledWith({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      values: { MODEL: null },
    });
  });

  it('clears a configured secret by saving an empty value', async () => {
    apiMocks.updateConfigs.mockResolvedValue({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      member: {},
      config: {},
      profiles: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AgentTeamConfigs
          config={{
            machine: 'machine-id',
            manifestPath: '/team/member/agentlet.yaml',
            fields: [
              {
                name: 'TOKEN',
                description: 'API token',
                required: true,
                secret: true,
                configured: true,
              },
            ],
            missingRequired: [],
            ready: true,
          }}
          onDetailChange={vi.fn()}
        />,
      );
    });

    const updateButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.updateKey',
    )!;
    act(() => updateButton.click());
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.save',
    )!;
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });

    expect(apiMocks.updateConfigs).toHaveBeenCalledWith({
      machine: 'machine-id',
      manifestPath: '/team/member/agentlet.yaml',
      values: { TOKEN: null },
    });
  });
});
