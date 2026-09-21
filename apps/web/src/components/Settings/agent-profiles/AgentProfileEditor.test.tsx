// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import { AgentProfileEditor } from './AgentProfileEditor';

import type {
  AcpAgentCliInfo,
  AcpProfileLaunchPreviewResponse,
  AgentProfileView,
} from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  preview: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/api/acp', () => ({
  createAcpProfile: api.create,
  updateAcpProfile: api.update,
  previewAcpProfileLaunch: api.preview,
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
  }: {
    value: string;
    options: { value: string; label: string; disabled?: boolean }[];
    onChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Loading</option>
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

const agents: AcpAgentCliInfo[] = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    binary: 'copilot',
    acpArgs: ['--acp'],
    autoApprove: { args: ['--allow-all'], position: 'after-acp' },
    installed: true,
    launchVersion: 1,
    launchPreviewVersion: 1,
    capabilities: {
      autoApprove: 'supported',
      customLaunchCommand: 'unsupported',
      modelOverride: 'unknown',
      sessionPersistence: 'unknown',
    },
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
const plan: AcpProfileLaunchPreviewResponse = {
  kind: 'exec',
  executable: '/daemon/copilot',
  argv: ['--acp', 'daemon-owned-argument'],
  env: { SECRET: 'must-not-render' },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const onSaved = vi.fn<() => Promise<void>>();
const onClose = vi.fn();

function renderEditor(
  editing?: AgentProfileView,
  clis = agents,
  loaded = true,
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
async function settlePreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}
function chooseCustom() {
  const select = container?.querySelector('select');
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
  api.preview.mockResolvedValue(plan);
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
    expect(api.preview).not.toHaveBeenCalled();
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
    const select = container?.querySelector('select');
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

  it('requires a daemon preview and explicit checkbox for elevated permissions', async () => {
    renderEditor();
    input('path', 'C:\\work\\project');
    act(() => approval()?.click());
    expect(container?.textContent).toContain(
      'settings.profilePermissionIncrease',
    );
    expect(saveButton()?.disabled).toBe(true);
    await settlePreview();
    expect(api.preview).toHaveBeenCalledWith({
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: true },
      },
    });
    expect(container?.textContent).toContain('daemon-owned-argument');
    expect(container?.textContent).not.toContain('must-not-render');
    expect(container?.textContent).not.toContain('SECRET');
    expect(
      container?.querySelector('[aria-label="settings.launchCommand"]'),
    ).toBeNull();
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledWith({
      alias: 'GitHub Copilot (project)',
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

  it('targets edit preview by saved Profile and patches only changed execution fields', async () => {
    renderEditor(structured);
    act(() => approval()?.click());
    input('path', '/different/work');
    expect(saveButton()?.disabled).toBe(true);
    await settlePreview();
    expect(api.preview).toHaveBeenCalledWith({
      profileId: 'profile-1',
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: true },
      },
    });
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
    await settlePreview();
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
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('falls back to manual creation for older daemons', () => {
    renderEditor(
      undefined,
      agents.map((agent) => ({ ...agent, launchPreviewVersion: undefined })),
    );
    expect(container?.querySelector('select')?.value).toBe('custom');
    expect(container?.textContent).toContain(
      'settings.structuredLaunchUnavailable',
    );
    expect(approval()).toBeNull();
  });

  it('uses the custom descriptor capability and never displays known-wrapper options for custom', () => {
    renderEditor(legacy, [
      {
        ...agents[0],
        id: 'custom',
        capabilities: {
          autoApprove: 'supported',
          modelOverride: 'supported',
          sessionPersistence: 'supported',
          customLaunchCommand: 'unknown',
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
          autoApprove: 'unsupported',
          modelOverride: 'unknown',
          sessionPersistence: 'unknown',
        },
      },
    ]);
    input('path', '/work/project');
    await settlePreview();
    await act(async () => saveButton()?.click());
    expect(api.create.mock.calls[0]?.[0].launch).toEqual({
      kind: 'acp-harness',
      harnessId: 'copilot',
    });
  });

  it('debounces rapid option changes into one preview request', async () => {
    renderEditor();
    act(() => approval()?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => approval()?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => approval()?.click());
    expect(api.preview).not.toHaveBeenCalled();
    await settlePreview();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.preview.mock.calls[0]?.[0].launch.options.autoApprove).toBe(
      true,
    );
  });

  it.each(['unknown', 'unsupported', undefined] as const)(
    'does not infer approval capability %s from catalogue arguments',
    async (status) => {
      renderEditor(structured, [
        {
          ...agents[0],
          capabilities: status
            ? {
                autoApprove: status,
                modelOverride: 'unknown',
                sessionPersistence: 'unknown',
              }
            : undefined,
        },
      ]);
      expect(approval()?.disabled).toBe(true);
      input('settings.displayName', 'Alias only');
      await act(async () => saveButton()?.click());
      expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty('launch');
    },
  );

  it('supports approval from capabilities even without legacy argument catalogue data', async () => {
    renderEditor(structured, [{ ...agents[0], autoApprove: null }]);
    expect(approval()?.disabled).toBe(false);
    act(() => approval()?.click());
    await settlePreview();
    expect(api.preview.mock.calls[0]?.[0].launch.options.autoApprove).toBe(
      true,
    );
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

  it('shows preview errors, prevents execution saves, and supports retry', async () => {
    api.preview.mockRejectedValueOnce(new Error('Target daemon offline'));
    renderEditor();
    input('path', '/work/project');
    await settlePreview();
    expect(container?.textContent).toContain('Target daemon offline');
    expect(saveButton()?.disabled).toBe(true);
    const retry = [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'settings.profilePreviewRetry',
    );
    act(() => retry?.click());
    await settlePreview();
    expect(saveButton()?.disabled).toBe(false);
  });

  it('allows alias saves despite failed previews when execution fields are untouched', async () => {
    api.preview.mockRejectedValueOnce(new Error('Target daemon offline'));
    renderEditor(structured);
    await settlePreview();
    input('settings.displayName', 'Offline rename');
    expect(saveButton()?.disabled).toBe(false);
    await act(async () => saveButton()?.click());
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty('launch');
  });

  it('debounces edits and ignores late preview results from an older draft', async () => {
    let oldResolve!: (value: AcpProfileLaunchPreviewResponse) => void;
    api.preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
    );
    renderEditor();
    input('path', '/work/project');
    await settlePreview();
    act(() => approval()?.click());
    expect(saveButton()?.disabled).toBe(true);
    await settlePreview();
    expect(api.preview).toHaveBeenCalledTimes(2);
    await act(async () =>
      oldResolve({ kind: 'shell', command: 'stale-preview' }),
    );
    expect(container?.textContent).not.toContain('stale-preview');
    expect(container?.textContent).toContain('daemon-owned-argument');
  });

  it('ignores stale preview failures after changing to custom', async () => {
    let reject!: (error: Error) => void;
    api.preview.mockImplementationOnce(
      () =>
        new Promise((_resolve, failure) => {
          reject = failure;
        }),
    );
    renderEditor();
    await settlePreview();
    chooseCustom();
    await act(async () => reject(new Error('Stale failure')));
    expect(container?.textContent).not.toContain('Stale failure');
    expect(approval()).toBeNull();
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
