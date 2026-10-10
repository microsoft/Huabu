// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import { AgentProfileEditor } from './AgentProfileEditor';

import type {
  AcpAgentCliInfo,
  AgentProfileView,
  ConnectedAgentletDevice,
} from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/api/acp', () => ({
  createAcpProfile: api.create,
  updateAcpProfile: api.update,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: api.toast }));
vi.mock('@/components/Common/PathInput', () => ({
  PathInput: ({
    value,
    onChange,
    disabled,
    pickerEnabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    pickerEnabled?: boolean;
  }) => (
    <input
      aria-label="path"
      value={value}
      disabled={disabled}
      data-picker-enabled={String(pickerEnabled)}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@/components/Common/Select', () => ({
  Select: ({
    value,
    options,
    onChange,
    ariaLabel,
  }: {
    value: string;
    options: {
      value: string;
      label: string;
      description?: string;
      disabled?: boolean;
    }[];
    onChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Loading</option>
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
          {option.description ? ` (${option.description})` : ''}
        </option>
      ))}
    </select>
  ),
}));

const agents: AcpAgentCliInfo[] = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    status: 'ready',
    capabilities: {
      autoApprove: true,
      customLaunchCommand: false,
    },
    installHint: 'Install Copilot',
  },
  {
    id: 'claude',
    displayName: 'Claude Agent',
    status: 'adapter-missing',
    installHint: 'Install Claude',
    capabilities: { autoApprove: false, customLaunchCommand: false },
  },
];

const legacy: AgentProfileView = {
  id: 'profile-1',
  alias: 'Reviewer',
  agentletId: 'machine-a',
  workingDirPath: 'C:\\work\\project',
  launch: { kind: 'acp-command', command: 'copilot --acp --allow-all' },
  metadata: { cliId: 'copilot' },
  customData: { icon: { shape: 'circle', color: 'blue' }, note: 'keep' },
};
const structured: AgentProfileView = {
  ...legacy,
  revision: 7,
  executionRevision: 4,
  launch: { kind: 'acp-harness', harnessId: 'copilot' },
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const onSaved = vi.fn<() => Promise<void>>();
const onClose = vi.fn();

function renderEditor(
  editing?: AgentProfileView,
  clis = agents,
  loaded = true,
  connectedDevices: ConnectedAgentletDevice[] = [
    {
      agentletId: editing?.agentletId ?? 'device-1',
      displayName: 'Test device: linux x64',
      hostname: 'Test device',
      platform: 'linux',
      arch: 'x64',
      version: '1.0.0',
      connectedAt: '2026-01-01T00:00:00.000Z',
      profileCount: 0,
    },
  ],
) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root?.render(
      <AgentProfileEditor
        {...(editing
          ? ({ mode: 'edit-command', profile: editing } as const)
          : ({ mode: 'create' } as const))}
        detectedClis={clis}
        detectionLoaded={loaded}
        connectedDevices={connectedDevices}
        agentletId={editing?.agentletId ?? 'device-1'}
        onAgentletChange={vi.fn()}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

function input(label: string, value: string) {
  const element = container?.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
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
function approval() {
  return container?.querySelector<HTMLInputElement>('input[type="checkbox"]');
}
function chooseCustom() {
  const select = container?.querySelector<HTMLSelectElement>(
    'select[aria-label="settings.agent"]',
  );
  act(() => {
    if (select) select.value = 'custom';
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  onSaved.mockResolvedValue(undefined);
  api.create.mockResolvedValue(legacy);
  api.update.mockResolvedValue(legacy);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('AgentProfileEditor', () => {
  it('uses launch identity only and never parses known-looking legacy commands', async () => {
    renderEditor(legacy);
    expect(container?.querySelector('select')).toBeNull();
    expect(approval()).toBeNull();
    expect(container?.textContent).toContain('settings.customCommand');
    expect(container?.textContent).toContain('machine-a');
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('copilot --acp --allow-all');
    expect(
      container
        ?.querySelector('[aria-label="path"]')
        ?.getAttribute('data-picker-enabled'),
    ).toBe('false');
    input('settings.displayName', 'Renamed');
    await act(async () => saveButton()?.click());
    expect(api.update).toHaveBeenCalledWith('profile-1', {
      expectedRevision: 0,
      alias: 'Renamed',
      customData: legacy.customData,
    });
  });

  it('renders human-readable device labels while retaining UUID identity details', () => {
    renderEditor();
    const machine = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="settings.profileMachine"]',
    );
    expect(machine?.selectedOptions[0]?.textContent).toContain(
      'Test device: linux x64',
    );
    expect(machine?.selectedOptions[0]?.textContent).toContain('device-1');
  });

  it('maps a hostname-era Profile to the unique connected device label', () => {
    renderEditor({ ...legacy, agentletId: 'legacy-host' }, agents, true, [
      {
        agentletId: 'device-uuid',
        displayName: 'legacy-host: linux x64',
        hostname: 'legacy-host',
        platform: 'linux',
        arch: 'x64',
        version: '1.0.0',
        connectedAt: '2026-01-01T00:00:00.000Z',
        profileCount: 1,
      },
    ]);

    expect(container?.textContent).toContain(
      'legacy-host: linux x64 (device-uuid)',
    );
  });

  it('edits custom command and cwd without changing wrapper, machine, metadata, or custom data', async () => {
    renderEditor({ ...legacy, revision: 9 });
    input('settings.launchCommand', 'new-agent --custom');
    input('path', '/new/work');
    await act(async () => saveButton()?.click());
    expect(api.update).toHaveBeenCalledWith('profile-1', {
      expectedRevision: 9,
      alias: 'Reviewer',
      customData: legacy.customData,
      launch: { kind: 'acp-command', command: 'new-agent --custom' },
      workingDirPath: '/new/work',
    });
    expect(container?.textContent).toContain(
      'settings.profileChangesNewExecutions',
    );
  });

  it('preserves an untouched structured recipe, including absent options', async () => {
    renderEditor(structured);
    input('settings.displayName', 'Renamed');
    await act(async () => saveButton()?.click());
    expect(api.update).toHaveBeenCalledWith('profile-1', {
      expectedRevision: 7,
      alias: 'Renamed',
      customData: legacy.customData,
    });
  });

  it('lists known wrappers with unsupported choices disabled and one Custom option', () => {
    renderEditor();
    const select = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="settings.agent"]',
    );
    expect(select?.value).toBe('copilot');
    expect(
      [...(select?.options ?? [])].filter(
        (option) => option.value === 'custom',
      ),
    ).toHaveLength(1);
    expect(
      [...(select?.options ?? [])].find((option) => option.value === 'claude')
        ?.disabled,
    ).toBe(true);
    expect(approval()?.checked).toBe(false);
    expect(saveButton()?.disabled).toBe(true);
  });

  it('requires an explicit checkbox for elevated permissions', async () => {
    renderEditor();
    input('path', 'C:\\work\\project');
    act(() => approval()?.click());
    expect(container?.textContent).toContain(
      'settings.profilePermissionIncrease',
    );
    expect(saveButton()?.disabled).toBe(false);
    expect(
      container?.querySelector('[aria-label="settings.launchCommand"]'),
    ).toBeNull();
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledWith({
      alias: 'GitHub Copilot (project)',
      agentletId: 'device-1',
      workingDirPath: 'C:\\work\\project',
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: true },
      },
      metadata: { cliId: 'copilot' },
      customData: {
        icon: { shape: expect.any(String), color: expect.any(String) },
      },
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('patches only changed execution fields', async () => {
    renderEditor(structured);
    act(() => approval()?.click());
    input('path', '/different/work');
    expect(saveButton()?.disabled).toBe(false);
    await act(async () => saveButton()?.click());
    expect(api.update).toHaveBeenCalledWith('profile-1', {
      expectedRevision: 7,
      alias: 'Reviewer',
      customData: legacy.customData,
      workingDirPath: '/different/work',
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: true },
      },
    });
  });

  it('saves cwd alone without rewriting launch options', async () => {
    renderEditor(structured);
    input('path', '/different/work');
    await act(async () => saveButton()?.click());
    expect(api.update.mock.calls[0]?.[1]).toMatchObject({
      workingDirPath: '/different/work',
    });
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty('launch');
  });

  it('allows manual creation without discovery or preview support, even while discovery is pending', async () => {
    renderEditor(undefined, [], false);
    chooseCustom();
    input('settings.launchCommand', 'my-agent --acp');
    input('path', '/work/project');
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        launch: { kind: 'acp-command', command: 'my-agent --acp' },
        metadata: { cliId: 'custom' },
      }),
    );
  });

  it('falls back to manual creation when known harnesses are unavailable', () => {
    renderEditor(
      undefined,
      agents.map((agent) => ({ ...agent, status: 'not-found' })),
    );
    expect(
      container?.querySelector<HTMLSelectElement>(
        'select[aria-label="settings.agent"]',
      )?.value,
    ).toBe('custom');
    expect(approval()).toBeNull();
  });

  it('uses the custom descriptor capability and never displays known-wrapper options for custom', () => {
    renderEditor(legacy, [
      {
        ...agents[0],
        id: 'custom',
        capabilities: {
          autoApprove: false,
          customLaunchCommand: false,
        },
      },
    ]);
    expect(approval()).toBeNull();
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.disabled,
    ).toBe(true);
    expect(container?.textContent).toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    expect(saveButton()?.disabled).toBe(false);
  });

  it('does not send unsupported launch options when creating a known wrapper', async () => {
    renderEditor(undefined, [
      {
        ...agents[0],
        capabilities: {
          autoApprove: false,
          customLaunchCommand: false,
        },
      },
    ]);
    input('path', '/work/project');
    await act(async () => saveButton()?.click());
    expect(api.create.mock.calls[0]?.[0].launch).toEqual({
      kind: 'acp-harness',
      harnessId: 'copilot',
    });
  });

  it('does not enable approval when the definition does not support it', async () => {
    renderEditor(structured, [
      {
        ...agents[0],
        capabilities: {
          autoApprove: false,
          customLaunchCommand: false,
        },
      },
    ]);
    expect(approval()?.disabled).toBe(true);
    input('settings.displayName', 'Alias only');
    await act(async () => saveButton()?.click());
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty('launch');
  });

  it('supports approval from definition capabilities', async () => {
    renderEditor(structured);
    expect(approval()?.disabled).toBe(false);
    act(() => approval()?.click());
    await act(async () => saveButton()?.click());
    expect(api.update.mock.calls[0]?.[1].launch.options.autoApprove).toBe(true);
  });

  it('keeps alias editing available offline and preserves saved approval defaults', async () => {
    renderEditor(
      {
        ...structured,
        launch: {
          kind: 'acp-harness',
          harnessId: 'copilot',
          options: { autoApprove: true },
        },
      },
      [],
    );
    expect(approval()?.checked).toBe(true);
    expect(approval()?.disabled).toBe(true);
    expect(
      container?.querySelector<HTMLInputElement>('[aria-label="path"]')
        ?.disabled,
    ).toBe(true);
    expect(container?.textContent).toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    input('settings.displayName', 'Offline alias');
    await act(async () => saveButton()?.click());
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty('launch');
  });

  it('does not reset unsaved edits when discovery changes', () => {
    renderEditor(legacy);
    input('settings.displayName', 'Draft');
    input('settings.launchCommand', 'draft --acp');
    renderEditor(legacy, []);
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.displayName"]',
      )?.value,
    ).toBe('Draft');
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('draft --acp');
  });

  it('reports revision conflict without retrying, overwriting, or closing the editor', async () => {
    api.update.mockRejectedValue(
      new ApiError(409, { code: 'profile_revision_conflict' }, 'Conflict'),
    );
    renderEditor(legacy);
    input('settings.displayName', 'My edit');
    await act(async () => saveButton()?.click());
    expect(api.toast).toHaveBeenCalledWith('settings.profileEditConflict', {
      tone: 'danger',
    });
    expect(api.update).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
