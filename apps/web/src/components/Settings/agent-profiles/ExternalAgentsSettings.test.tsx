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
  return { useDetectedClis: () => ({ detectedClis, loaded: true }) };
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
  const button = [...(container?.querySelectorAll('button') ?? [])].find(
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
    agentlet: null,
  }));
  useAcpProfilesStore.setState({
    profiles: [],
    selectableProfileIds: [],
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
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('ExternalAgentsSettings', () => {
  it('refreshes the singleton on every mount and lists all Profiles, including unavailable ones', async () => {
    await renderSettings();
    expect(container?.textContent).toContain('Reviewer');
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
    input(
      'input[placeholder="/usr/local/bin/copilot --acp --allow-all"]',
      'agent --acp',
    );
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
    await click('settings.editProfile');
    input('input[type="text"]', 'Renamed');
    await click('settings.saveChanges');

    expect(apiMocks.update).toHaveBeenCalledWith(profile.id, {
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
    await click('settings.deleteProfile');
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
