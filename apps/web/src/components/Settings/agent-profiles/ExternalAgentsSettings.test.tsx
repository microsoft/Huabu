// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { ExternalAgentsSettings } from './ExternalAgentsSettings';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type { ModalProps } from '@/components/Common/Modal';
import type { AcpCommandProfileView } from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  restart: vi.fn(),
  toast: vi.fn(),
  detection: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  listAcpProfiles: apiMocks.list,
  listAcpAgentClis: vi.fn(),
  createAcpProfile: apiMocks.create,
  updateAcpProfile: apiMocks.update,
  deleteAcpProfile: apiMocks.delete,
  restartAcpAgentlet: apiMocks.restart,
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

vi.mock('@/components/Common/Toast', () => ({ toast: apiMocks.toast }));
vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <span>Loading</span>,
}));
vi.mock('@/components/Common/Modal', () => ({
  Modal: ({ isOpen, children }: ModalProps) =>
    isOpen ? <div role="dialog">{children}</div> : null,
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
vi.mock('./useDetectedClis', () => {
  const detectedClis: [] = [];
  return {
    useDetectedClis: (enabled: boolean, profileId?: string) => {
      apiMocks.detection(enabled, profileId);
      return { detectedClis, loaded: true };
    },
  };
});
vi.mock('./AgentIconPicker', () => ({
  AgentIconPicker: ({
    onChange,
  }: {
    onChange: (icon: AgentIconValue) => void;
  }) => (
    <button onClick={() => onChange({ shape: 'diamond', color: 'red' })}>
      Change icon
    </button>
  ),
}));

const profile: AcpCommandProfileView = {
  id: 'profile-1',
  alias: 'Reviewer',
  agentletId: 'local',
  workingDirPath: '/work/project',
  launch: { kind: 'acp-command', command: 'agent --acp' },
  metadata: { cliId: 'custom' },
  customData: { note: 'keep' },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let profiles: AcpCommandProfileView[];
const onNavigationChange = vi.fn();

async function renderSettings() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ExternalAgentsSettings onNavigationChange={onNavigationChange} />,
    );
  });
}

async function click(label: string) {
  if (label === 'menu.edit') label = 'settings.editAgentProfile';
  if (label === 'actions.delete') label = 'settings.deleteAgentProfile';
  const button = [...document.querySelectorAll('button')].find(
    (element) =>
      element.getAttribute('aria-label') === label ||
      element.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button?.click());
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

beforeEach(() => {
  profiles = [profile];
  apiMocks.list.mockImplementation(async () => ({
    profiles: [...profiles],
    selectableProfileIds: [],
    connectedDevices: [
      {
        agentletId: 'local',
        displayName: 'Local machine: linux x64',
        hostname: 'Local machine',
        platform: 'linux',
        arch: 'x64',
        version: '1.0.0',
        connectedAt: '2026-01-01T00:00:00.000Z',
        profileCount: 1,
      },
    ],
    agentlet: null,
  }));
  useAcpProfilesStore.setState({
    profiles: [],
    selectableProfileIds: [],
    connectedDevices: [],
    agentlet: null,
    loaded: true,
    loading: false,
    error: null,
    initStarted: true,
  });
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('ExternalAgentsSettings', () => {
  it('retains offline and ambiguous legacy Profiles without routing them to an arbitrary device', async () => {
    await renderSettings();
    const device = useAcpProfilesStore.getState().connectedDevices[0];
    await act(async () =>
      useAcpProfilesStore.setState({
        connectedDevices: [
          { ...device, hostname: 'same' },
          { ...device, agentletId: 'other', hostname: 'same' },
        ],
        profiles: [
          profile,
          { ...profile, id: 'legacy', alias: 'Legacy', agentletId: 'same' },
          { ...profile, id: 'offline', alias: 'Offline', agentletId: 'gone' },
          { ...profile, id: 'duplicate', alias: 'Reviewer' },
        ],
      }),
    );
    const local = container?.querySelector('[data-device-id="local"]');
    expect(
      local?.querySelectorAll('[data-editor-trigger^="command:"]'),
    ).toHaveLength(2);
    expect(local?.textContent).not.toContain('Legacy');
    expect(container?.textContent).toContain('Legacy');
    expect(container?.textContent).toContain('Offline');
    expect(
      container?.querySelector('[data-device-id="same"]')?.textContent,
    ).toContain('Legacy');
    expect(
      container?.querySelector('[data-device-id="gone"]')?.textContent,
    ).toContain('Offline');
    for (const id of ['same', 'gone']) {
      expect(
        container?.querySelector(`[data-device-id="${id}"]`)?.textContent,
      ).not.toContain('settings.agentUnavailable');
    }
    expect(
      apiMocks.detection.mock.calls.every((call) => call[0] === false),
    ).toBe(true);
  });
  it('groups Profiles under one device fold and keeps Add actions outside the fold', async () => {
    await renderSettings();
    const agent = container?.querySelector<HTMLButtonElement>(
      '[data-editor-trigger="create:local"]',
    );
    const section = agent?.closest('[data-device-id]');
    expect(section?.textContent).toContain('Reviewer');
    const heading = section?.querySelector<HTMLButtonElement>(
      'button[aria-controls]',
    );
    expect(heading?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => heading?.click());
    const card = document.getElementById(
      heading?.getAttribute('aria-controls') ?? '',
    );
    expect(card?.hidden).toBe(true);
    expect(agent?.closest('[hidden]')).toBeNull();
    expect(agent?.disabled).toBe(false);
    await act(async () =>
      useAcpProfilesStore.setState({
        connectedDevices: [...useAcpProfilesStore.getState().connectedDevices],
      }),
    );
    expect(heading?.getAttribute('aria-expanded')).toBe('false');
    await click('settings.addDevice');
    expect(container?.textContent).toContain('git clone');
  });

  it.each([false, true])(
    'keeps Connect available below the list and scopes Add to online devices: %s',
    async (empty) => {
      await renderSettings();
      if (empty) {
        await act(async () =>
          useAcpProfilesStore.setState({
            profiles: [],
            connectedDevices: [],
            knownDevices: [],
          }),
        );
      }
      const device = container?.querySelector<HTMLButtonElement>(
        '[data-editor-trigger="connect-device"]',
      );
      const agent = container?.querySelector<HTMLButtonElement>(
        '[data-editor-trigger="create:local"]',
      );
      expect(device?.closest('[data-device-id]')).toBeNull();
      if (empty) {
        expect(agent).toBeNull();
        expect(container?.textContent).toContain('settings.noConnectedDevices');
      } else expect(agent?.closest('[data-device-id]')).not.toBeNull();
      expect(device?.disabled).toBe(false);
    },
  );

  it('uses one Add action per entity without repeating titles and explanations', async () => {
    await renderSettings();
    expect(container?.textContent?.match(/settings.addAgent/g)).toHaveLength(1);
    expect(container?.textContent?.match(/settings.addDevice/g)).toHaveLength(
      1,
    );
    expect(container?.textContent).not.toContain('settings.addAnotherAgent');
    expect(container?.textContent).not.toContain('settings.connectAgentDevice');
  });

  it('opens device connection as a focused view and restores the Add device trigger on Back', async () => {
    await renderSettings();
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[data-editor-trigger="connect-device"]',
    );
    expect(trigger?.hasAttribute('aria-expanded')).toBe(false);
    expect(container?.textContent).not.toContain('git clone');

    await click('settings.addDevice');
    expect(container?.contains(trigger ?? null)).toBe(false);
    expect(container?.textContent).toContain('git clone');
    expect(container?.querySelector('[data-device-id]')).toBeNull();
    expect(container?.textContent).not.toContain(
      'settings.externalAgentIdleTimeout',
    );
    expect(apiMocks.detection.mock.lastCall?.[0]).toBe(false);
    const navigation = onNavigationChange.mock.lastCall?.[0];
    expect(navigation?.title).toBe('settings.addDevice');
    expect(navigation?.onBack).toBeTypeOf('function');

    await act(async () => navigation.onBack());
    const restoredTrigger = container?.querySelector<HTMLButtonElement>(
      '[data-editor-trigger="connect-device"]',
    );
    expect(document.activeElement).toBe(restoredTrigger);
    expect(container?.textContent).not.toContain('git clone');
    expect(container?.textContent).toContain('Local machine: linux x64');
    expect(onNavigationChange.mock.lastCall?.[0]).toBeNull();
  });

  it('offers connection instructions even when no device is connected', async () => {
    await renderSettings();
    await act(async () =>
      useAcpProfilesStore.setState({ connectedDevices: [] }),
    );
    expect(container?.textContent).toContain('settings.localAgentDisabled');
    await click('settings.addDevice');
    expect(container?.textContent).toContain('git clone');
  });

  it.each([false, true])(
    'only replaces the catalogue with a loading row before its first load (loaded: %s)',
    async (loaded) => {
      await renderSettings();
      await act(async () =>
        useAcpProfilesStore.setState({ loading: true, loaded }),
      );
      expect(container?.textContent?.includes('Reviewer')).toBe(loaded);
      expect(container?.textContent?.includes('settings.loadingAgents')).toBe(
        !loaded,
      );
      expect(
        container?.querySelector<HTMLButtonElement>(
          '[data-editor-trigger="create:local"]',
        ) !== null,
      ).toBe(loaded);
      expect(
        container?.querySelector<HTMLButtonElement>(
          '[data-editor-trigger="connect-device"]',
        )?.disabled,
      ).toBe(false);
      await act(async () =>
        useAcpProfilesStore.setState({ loading: false, loaded: true }),
      );
      expect(container?.textContent).toContain('Reviewer');
    },
  );

  it('refreshes Agent settings every five seconds only while visible and mounted', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility,
    );
    await renderSettings();
    expect(apiMocks.list).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiMocks.list).toHaveBeenCalledTimes(2);

    visibility = 'hidden';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiMocks.list).toHaveBeenCalledTimes(2);

    act(() => root?.unmount());
    root = undefined;
    visibility = 'visible';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(apiMocks.list).toHaveBeenCalledTimes(2);
  });

  it('refreshes the singleton on every mount and lists all Profiles, including unavailable ones', async () => {
    await renderSettings();
    expect(container?.textContent).toContain('Reviewer');
    expect(container?.textContent).toContain('Local machine: linux x64');
    expect(useAcpProfilesStore.getState().profiles).toEqual([profile]);
    profiles = [
      profile,
      { ...profile, id: 'profile-2', alias: 'Second Reviewer' },
    ];
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    await renderSettings();

    expect(apiMocks.list).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain('Second Reviewer');
    expect(useAcpProfilesStore.getState().profiles).toHaveLength(2);
  });

  it('creates a custom Profile and refreshes the shared list', async () => {
    const created = { ...profile, id: 'profile-2', alias: 'Second Reviewer' };
    apiMocks.create.mockImplementation(async () => {
      profiles = [...profiles, created];
      return created;
    });
    await renderSettings();
    await click('settings.addAgent');
    await click('settings.customCommand');
    input('input[aria-label="settings.launchCommand"]', 'agent --acp');
    input('[aria-label="path"]', '/work/project');
    await click('settings.createProfile');

    expect(apiMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        launch: { kind: 'acp-command', command: 'agent --acp' },
        workingDirPath: '/work/project',
      }),
    );
    expect(apiMocks.list).toHaveBeenCalledTimes(2);
    expect(useAcpProfilesStore.getState().profiles).toHaveLength(2);
    expect(container?.textContent).toContain('Second Reviewer');
  });

  it('saves alias changes and refreshes without replacing runtime configuration', async () => {
    apiMocks.update.mockImplementation(async () => {
      profiles = [{ ...profile, alias: 'Renamed' }];
      return profiles[0];
    });
    await renderSettings();
    await click('menu.edit');
    expect(apiMocks.detection).toHaveBeenLastCalledWith(true, {
      profileId: profile.id,
    });
    input('input[aria-label="settings.displayName"]', 'Renamed');
    await click('settings.saveChanges');

    expect(apiMocks.update).toHaveBeenCalledWith(profile.id, {
      expectedRevision: 0,
      alias: 'Renamed',
      customData: expect.objectContaining({ note: 'keep' }),
    });
    expect(apiMocks.list).toHaveBeenCalledTimes(2);
    expect(useAcpProfilesStore.getState().profiles[0].alias).toBe('Renamed');
  });

  it('preserves custom data when changing an icon and refreshes the singleton', async () => {
    apiMocks.update.mockResolvedValue(profile);
    await renderSettings();
    await click('Change icon');

    expect(apiMocks.update).toHaveBeenCalledWith(profile.id, {
      expectedRevision: 0,
      customData: { note: 'keep', icon: { shape: 'diamond', color: 'red' } },
    });
    expect(apiMocks.list).toHaveBeenCalledTimes(2);
  });

  it('confirms deletion and refreshes every subscriber', async () => {
    apiMocks.delete.mockImplementation(async () => {
      profiles = [];
      return { deleted: true };
    });
    await renderSettings();
    await click('actions.delete');
    const confirm = container
      ?.querySelector('[role="dialog"]')
      ?.querySelectorAll('button')[1];
    expect(confirm).toBeTruthy();
    await act(async () => confirm?.click());

    expect(apiMocks.delete).toHaveBeenCalledWith(profile.id);
    expect(apiMocks.list).toHaveBeenCalledTimes(2);
    expect(useAcpProfilesStore.getState().profiles).toEqual([]);
    expect(container?.textContent).not.toContain('Reviewer');
  });
});
