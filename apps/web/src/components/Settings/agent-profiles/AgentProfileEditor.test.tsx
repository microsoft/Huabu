// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentProfileEditor } from './AgentProfileEditor';

import type { AcpAgentCliInfo, AcpCommandProfileView } from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createCommand: vi.fn(),
  updateCommand: vi.fn(),
  listClis: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/api/acp', () => ({
  createAcpProfile: apiMocks.createCommand,
  listAcpAgentClis: apiMocks.listClis,
  updateAcpProfile: apiMocks.updateCommand,
}));

vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="path"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/components/Common/Select', () => ({
  Select: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: { value: string; label: string; disabled?: boolean }[];
    onChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/components/Common/Toast', () => ({ toast: apiMocks.toast }));

const agents: AcpAgentCliInfo[] = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    binary: 'copilot',
    acpArgs: ['--acp'],
    autoApprove: { args: ['--allow-all'], position: 'after-acp' },
    installed: true,
    installHint: 'Install Copilot',
  },
  {
    id: 'claude',
    displayName: 'Claude Agent',
    binary: 'claude-agent-acp',
    acpArgs: [],
    autoApprove: null,
    installed: false,
    installHint: 'Install Claude',
  },
];

const profile: AcpCommandProfileView = {
  id: 'profile-1',
  alias: 'Reviewer',
  agentletId: 'machine-a',
  workingDirPath: 'C:\\work\\project',
  launch: { kind: 'acp-command', command: 'copilot --acp --allow-all' },
  metadata: { cliId: 'copilot' },
  customData: { icon: { shape: 'circle', color: 'blue' }, note: 'keep' },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const onSaved = vi.fn<() => Promise<void>>();
const onClose = vi.fn();

function renderEditor(editing?: AcpCommandProfileView, clis = agents) {
  onSaved.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AgentProfileEditor
        {...(editing
          ? { mode: 'edit-command' as const, profile: editing }
          : { mode: 'create' as const })}
        detectedClis={clis}
        detectionLoaded
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

function input(selector: string, value: string) {
  const element = container?.querySelector<HTMLInputElement>(selector);
  expect(element).toBeTruthy();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(element, value);
    element?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function saveButton() {
  return [...(container?.querySelectorAll('button') ?? [])].at(-1);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.resetAllMocks();
});

describe('AgentProfileEditor', () => {
  it('lists daemon CLIs with missing entries disabled and a custom command option', () => {
    renderEditor();
    const selects = container?.querySelectorAll('select');
    expect(selects?.length).toBe(1);
    expect(selects?.[0]?.value).toBe('copilot');
    const options = [...(selects?.[0]?.options ?? [])];
    expect(options.map((option) => option.value)).toEqual([
      'copilot',
      'claude',
      'custom',
    ]);
    expect(options[1]?.disabled).toBe(true);
    expect(container?.textContent).not.toContain('settings.template');
    expect(saveButton()?.disabled).toBe(true);
  });

  it('creates an ordinary command Profile with the required path and manual approval flag', async () => {
    apiMocks.listClis.mockResolvedValue({ agents });
    apiMocks.createCommand.mockResolvedValue(profile);
    renderEditor();
    input('[aria-label="path"]', 'C:\\work\\project');
    act(() =>
      container
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click(),
    );
    expect(saveButton()?.disabled).toBe(false);
    await act(async () => saveButton()?.click());

    expect(apiMocks.createCommand).toHaveBeenCalledWith({
      alias: 'GitHub Copilot (project)',
      workingDirPath: 'C:\\work\\project',
      launch: { kind: 'acp-command', command: 'copilot --acp --allow-all' },
      metadata: { cliId: 'copilot' },
      customData: {
        icon: { shape: expect.any(String), color: expect.any(String) },
      },
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps manual creation usable without a detected catalogue', async () => {
    apiMocks.createCommand.mockResolvedValue(profile);
    renderEditor(undefined, []);
    expect(container?.querySelector('select')?.value).toBe('custom');
    input(
      'input[placeholder="/usr/local/bin/copilot --acp --allow-all"]',
      'my-agent --acp',
    );
    input('[aria-label="path"]', '/work/project');
    await act(async () => saveButton()?.click());

    expect(apiMocks.listClis).not.toHaveBeenCalled();
    expect(apiMocks.createCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirPath: '/work/project',
        launch: { kind: 'acp-command', command: 'my-agent --acp' },
        metadata: { cliId: 'custom' },
      }),
    );
  });

  it('does not create a structured Profile if detection no longer finds the CLI', async () => {
    apiMocks.listClis.mockResolvedValue({ agents: [] });
    renderEditor();
    input('[aria-label="path"]', '/work/project');
    await act(async () => saveButton()?.click());

    expect(apiMocks.createCommand).not.toHaveBeenCalled();
    expect(apiMocks.toast).toHaveBeenCalledWith(
      'settings.selectedAgentUnavailable',
      {
        tone: 'danger',
      },
    );
  });

  it('reports detection errors instead of creating from a stale catalogue', async () => {
    apiMocks.listClis.mockRejectedValue(new Error('Daemon unavailable'));
    renderEditor();
    input('[aria-label="path"]', '/work/project');
    await act(async () => saveButton()?.click());

    expect(apiMocks.createCommand).not.toHaveBeenCalled();
    expect(apiMocks.toast).toHaveBeenCalledWith('Daemon unavailable', {
      tone: 'danger',
    });
    expect(saveButton()?.disabled).toBe(false);
  });

  it('edits alias and icon while leaving runtime fields read-only', async () => {
    apiMocks.updateCommand.mockResolvedValue(profile);
    renderEditor(profile);
    expect(container?.querySelector('select')).toBeNull();
    expect(container?.querySelector('[aria-label="path"]')).toBeNull();
    expect(container?.textContent).toContain('C:\\work\\project');
    const approval = container?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(approval?.checked).toBe(true);
    expect(approval?.disabled).toBe(true);
    input('input[type="text"]', 'Project Reviewer');
    expect(apiMocks.updateCommand).not.toHaveBeenCalled();
    await act(async () => saveButton()?.click());

    expect(apiMocks.updateCommand).toHaveBeenCalledWith('profile-1', {
      alias: 'Project Reviewer',
      customData: profile.customData,
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
