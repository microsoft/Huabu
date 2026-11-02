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
    targetAgentletId,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    targetAgentletId?: string;
  }) => (
    <input
      aria-label="path"
      value={value}
      disabled={disabled}
      data-picker-target={targetAgentletId}
      onChange={(event) => onChange(event.target.value)}
    />
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
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

function input(label: string, value: string) {
  const element = [
    ...(container?.querySelectorAll<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    ) ?? []),
  ].find((input) => !input.closest('[hidden]'));
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
  return [...(container?.querySelectorAll('button') ?? [])]
    .filter((button) => !button.closest('[hidden]'))
    .at(-1);
}
function approval() {
  return container?.querySelector<HTMLButtonElement>('[role="switch"]');
}
function chooseCustom() {
  chooseAgent('settings.customCommand');
}
function chooseAgent(name: string) {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.startsWith(name),
  );
  expect(button).toBeTruthy();
  act(() => button?.click());
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
  it('dismisses draft icon popovers on Change without discarding the draft', async () => {
    renderEditor();
    chooseAgent('GitHub Copilot');
    input('settings.displayName', 'My reviewer');
    const icon = container?.querySelector<HTMLButtonElement>(
      '[aria-label="settings.agentIcon.change"]',
    );
    expect(icon).toBeTruthy();
    await act(async () => icon?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    chooseAgent('settings.changeAgent');
    await act(async () => vi.advanceTimersByTime(20));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
    chooseAgent('GitHub Copilot');
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.displayName"]',
      )?.value,
    ).toBe('My reviewer');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'focuses an available option when the selected harness is absent (loaded=%s)',
    async (loaded) => {
      renderEditor();
      chooseAgent('GitHub Copilot');
      renderEditor(undefined, [], loaded);
      chooseAgent('settings.changeAgent');
      await act(async () => vi.advanceTimersByTime(20));
      expect(document.activeElement?.textContent).toBe(
        'settings.customCommand',
      );
      expect(document.activeElement?.getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(api.create).not.toHaveBeenCalled();
    },
  );

  it('preserves per-harness drafts, icon and approval while changing the selection', () => {
    renderEditor();
    chooseAgent('GitHub Copilot');
    input('settings.displayName', 'My reviewer');
    input('path', '/work/first');
    act(() => approval()?.click());
    chooseAgent('settings.changeAgent');
    chooseCustom();
    input('settings.launchCommand', 'my-agent --acp');
    input('path', '/work/second');
    chooseAgent('settings.changeAgent');
    chooseAgent('GitHub Copilot');
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.displayName"]',
      )?.value,
    ).toBe('My reviewer');
    expect(approval()?.getAttribute('aria-checked')).toBe('true');
    chooseAgent('settings.changeAgent');
    chooseCustom();
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('my-agent --acp');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('unlocks configuration after read-only detection without creating a Profile', () => {
    renderEditor();
    chooseAgent('Claude Agent');
    expect(saveButton()?.disabled).toBe(true);
    renderEditor(
      undefined,
      agents.map((agent) => ({ ...agent, status: 'ready' })),
    );
    expect(container?.querySelector('[aria-label="path"]')).not.toBeNull();
    expect(container?.textContent).not.toContain('Install Claude');
    expect(api.create).not.toHaveBeenCalled();
  });

  it.each(['create', 'edit'] as const)(
    'does not show a refresh failure during or after a successful delayed %s',
    async (mode) => {
      let finishRefresh: () => void = () => {};
      onSaved.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve;
          }),
      );
      renderEditor(mode === 'edit' ? legacy : undefined);
      if (mode === 'create') {
        chooseCustom();
        input('settings.launchCommand', 'my-agent --acp');
        input('path', '/work/project');
      }
      await act(async () => saveButton()?.click());
      expect(onSaved).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
      expect(saveButton()?.disabled).toBe(true);
      expect(container?.textContent).not.toContain(
        'settings.profileSavedRefreshFailed',
      );
      await act(async () => finishRefresh());
      expect(onClose).toHaveBeenCalledOnce();
      expect(container?.textContent).not.toContain(
        'settings.profileSavedRefreshFailed',
      );
    },
  );

  it('retries only refresh after a successful creation whose publication failed', async () => {
    onSaved.mockRejectedValueOnce(new Error('Refresh failed'));
    renderEditor();
    chooseCustom();
    input('settings.launchCommand', 'my-agent --acp');
    input('path', '/work/project');
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton()?.textContent).toBe('settings.retryRefresh');
    expect(container?.textContent).toContain(
      'settings.profileSavedRefreshFailed',
    );
    let rejectRefresh: (reason: Error) => void = () => {};
    onSaved.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    await act(async () => saveButton()?.click());
    expect(container?.textContent).not.toContain(
      'settings.profileSavedRefreshFailed',
    );
    expect(saveButton()?.disabled).toBe(true);
    await act(async () => rejectRefresh(new Error('Still offline')));
    expect(container?.textContent).toContain(
      'settings.profileSavedRefreshFailed',
    );
    expect(api.create).toHaveBeenCalledOnce();
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(container?.textContent).not.toContain(
      'settings.profileSavedRefreshFailed',
    );
  });

  it('retains the manual draft but blocks creation while its exact device is disconnected', async () => {
    renderEditor();
    chooseCustom();
    input('settings.launchCommand', 'my-agent --acp');
    input('path', '/work/project');
    renderEditor(undefined, agents, true, []);
    expect(saveButton()?.disabled).toBe(true);
    await act(async () => saveButton()?.click());
    expect(api.create).not.toHaveBeenCalled();
    renderEditor();
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('my-agent --acp');
    expect(saveButton()?.disabled).toBe(false);
  });

  it('retains a failed creation draft and only retries on explicit submission', async () => {
    api.create.mockRejectedValueOnce(new Error('Device unavailable'));
    renderEditor();
    chooseCustom();
    input('settings.launchCommand', 'my-agent --acp');
    input('path', '/work/project');
    await act(async () => saveButton()?.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(api.toast).toHaveBeenCalledWith('Device unavailable', {
      tone: 'danger',
    });
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('my-agent --acp');
    await act(async () => saveButton()?.click());
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not present a failed lookup as a confirmed missing installation', () => {
    renderEditor(undefined, [
      {
        ...agents[0],
        status: 'not-found',
        diagnostics: [{ code: 'lookup_failed', message: 'Lookup timed out' }],
      },
    ]);
    chooseAgent('GitHub Copilot');
    expect(container?.textContent).toContain(
      'settings.deviceDetectionLookupFailed',
    );
    expect(container?.textContent).not.toContain(
      'settings.agentInstallRequired',
    );
    expect(saveButton()?.disabled).toBe(true);
  });
  it('labels the device as fixed only while editing', () => {
    renderEditor();
    expect(container?.textContent).toContain('settings.profileMachine');
    expect(container?.textContent).not.toContain(
      'settings.profileMachineFixed',
    );
    expect(
      container?.querySelector('select[aria-label="settings.profileMachine"]'),
    ).toBeNull();
    renderEditor(structured);
    expect(container?.textContent).toContain('settings.profileMachineFixed');
    expect(
      container?.querySelector('select[aria-label="settings.profileMachine"]'),
    ).toBeNull();
  });

  it('uses launch identity only and never parses known-looking legacy commands', async () => {
    renderEditor(legacy);
    expect(container?.querySelector('select')).toBeNull();
    expect(approval()).toBeNull();
    expect(container?.textContent).toContain('settings.customCommand');
    expect(container?.textContent).toContain('Test device: linux x64');
    expect(
      container?.querySelector<HTMLInputElement>(
        '[aria-label="settings.launchCommand"]',
      )?.value,
    ).toBe('copilot --acp --allow-all');
    expect(
      container
        ?.querySelector('[aria-label="path"]')
        ?.getAttribute('data-picker-target'),
    ).toBe('machine-a');
    input('settings.displayName', 'Renamed');
    await act(async () => saveButton()?.click());
    expect(api.update).toHaveBeenCalledWith('profile-1', {
      expectedRevision: 0,
      alias: 'Renamed',
      customData: legacy.customData,
    });
  });

  it('fixes creation to the selected device without exposing its UUID in the form', () => {
    renderEditor();
    expect(container?.textContent).toContain('Test device: linux x64');
    expect(container?.textContent).not.toContain('device-1');
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

    expect(container?.textContent).toContain('legacy-host: linux x64');
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

  it('keeps the edit form mounted without unsupported warnings while discovery is pending', () => {
    renderEditor(structured, [], false);
    const name = container?.querySelector<HTMLInputElement>(
      '[aria-label="settings.displayName"]',
    );
    const path = container?.querySelector<HTMLInputElement>(
      '[aria-label="path"]',
    );
    const toggle = approval();
    expect(path?.disabled).toBe(true);
    expect(toggle?.disabled).toBe(true);
    expect(name?.disabled).toBe(false);
    expect(saveButton()?.disabled).toBe(false);
    expect(container?.textContent).not.toContain(
      'settings.profileApprovalUnsupported',
    );
    expect(container?.textContent).not.toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    input('settings.displayName', 'My draft');
    renderEditor(structured);
    expect(
      container?.querySelector('[aria-label="settings.displayName"]'),
    ).toBe(name);
    expect(name?.value).toBe('My draft');
    expect(path?.disabled).toBe(false);
    expect(approval()).toBe(toggle);
    expect(toggle?.disabled).toBe(false);
    expect(container?.textContent).not.toContain(
      'settings.profileApprovalUnsupported',
    );
    expect(container?.textContent).not.toContain(
      'settings.profileExecutionEditingUnavailable',
    );
  });

  it('shows genuine unavailable warnings only after discovery settles and hides them during recheck', () => {
    renderEditor(structured, [], false);
    expect(container?.textContent).not.toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    renderEditor(structured, [], true);
    expect(container?.textContent).toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    expect(container?.textContent).toContain(
      'settings.profileApprovalUnsupported',
    );
    expect(approval()?.disabled).toBe(true);
    expect(saveButton()?.disabled).toBe(false);
    renderEditor(structured, [], false);
    expect(container?.textContent).not.toContain(
      'settings.profileExecutionEditingUnavailable',
    );
    expect(container?.textContent).not.toContain(
      'settings.profileApprovalUnsupported',
    );
    renderEditor(structured, [
      {
        ...agents[0],
        capabilities: { autoApprove: false, customLaunchCommand: false },
      },
    ]);
    expect(container?.textContent).toContain(
      'settings.profileApprovalUnsupported',
    );
    expect(container?.textContent).not.toContain(
      'settings.profileExecutionEditingUnavailable',
    );
  });

  it('lists unavailable harnesses as selectable installation flows, without a dropdown', () => {
    renderEditor();
    expect(container?.querySelector('select')).toBeNull();
    expect(container?.querySelectorAll('[aria-pressed]')).toHaveLength(3);
    chooseAgent('Claude Agent');
    expect(container?.textContent).toContain('Install Claude');
    expect(container?.textContent).toContain('settings.agentInstallAdapter');
    expect(approval()).toBeNull();
    expect(saveButton()?.disabled).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('requires an explicit toggle for elevated permissions', async () => {
    renderEditor();
    chooseAgent('GitHub Copilot');
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

  it('keeps unavailable harnesses visible and requires explicit manual selection', () => {
    renderEditor(
      undefined,
      agents.map((agent) => ({ ...agent, status: 'not-found' })),
    );
    expect(container?.querySelectorAll('[aria-pressed]')).toHaveLength(3);
    chooseCustom();
    expect(
      container?.querySelector('[aria-label="settings.launchCommand"]'),
    ).not.toBeNull();
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
    chooseAgent('GitHub Copilot');
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
    expect(approval()?.getAttribute('aria-checked')).toBe('true');
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
