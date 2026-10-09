// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsModal } from './SettingsModal';

import type { Root } from 'react-dom/client';

type RequestedTab = 'builtIn' | 'capabilities' | null;

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  load: vi.fn(),
  clear: vi.fn(),
  llmInit: vi.fn(),
  profileId: 'external',
  requestedTab: null as RequestedTab,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useElectron', () => ({
  getElectronBridge: () => undefined,
}));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: {
      init: typeof mocks.init;
      agentDefaults: { profileId: string };
    }) => unknown,
  ) =>
    selector({
      init: mocks.init,
      agentDefaults: { profileId: mocks.profileId },
    }),
}));
vi.mock('@/store/llmStore', () => ({
  useLLMStore: (selector: (state: { init: typeof mocks.init }) => unknown) =>
    selector({ init: mocks.llmInit }),
}));
vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (
    selector: (state: { load: typeof mocks.load }) => unknown,
  ) => selector({ load: mocks.load }),
}));
vi.mock('@/store/settingsUiStore', () => ({
  useSettingsUiStore: (
    selector: (state: {
      requestedTab: RequestedTab;
      clearRequestedTab: typeof mocks.clear;
    }) => unknown,
  ) =>
    selector({
      requestedTab: mocks.requestedTab,
      clearRequestedTab: mocks.clear,
    }),
}));
vi.mock('./agent-profiles/AgentDefaultsSettings', () => ({
  AgentDefaultsSettings: () => <div data-testid="agent-defaults" />,
}));
vi.mock('./agent-profiles/ExternalAgentsSettings', () => ({
  ExternalAgentsSettings: () => <div data-testid="profile-management" />,
}));
vi.mock('./DeploymentReadinessNotice', () => ({
  DeploymentReadinessNotice: () => null,
}));
vi.mock('./sections/AgentBehaviorSettings', () => ({
  AgentBehaviorSettings: () => <div data-testid="agent-behavior" />,
}));
vi.mock('./sections/ExternalAgentRuntimeSettings', () => ({
  ExternalAgentRuntimeSettings: () => <div data-testid="agent-runtime" />,
}));
vi.mock('./sections/GeneralSettings', () => ({
  GeneralSettings: () => <div data-testid="general-settings" />,
}));
vi.mock('./sections/LLMSettings', () => ({
  LLMSettings: () => <div data-testid="built-in-settings" />,
}));
vi.mock('./sections/CapabilitiesSettings', () => ({
  CapabilitiesSettings: () => <div data-testid="capabilities-settings" />,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profileId = 'external';
  mocks.requestedTab = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderModal(isOpen = true) {
  await act(async () => {
    root.render(<SettingsModal isOpen={isOpen} onClose={vi.fn()} />);
  });
}

function findTab(label: string): HTMLButtonElement {
  const tab = [...container.querySelectorAll('nav button')].find(
    (button) => button.textContent === label,
  );
  expect(tab).toBeDefined();
  return tab as HTMLButtonElement;
}

describe('Settings information architecture', () => {
  it('co-locates Agent defaults, Profiles, behavior, and runtime settings', async () => {
    await renderModal();

    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-behavior"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-runtime"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).toBeNull();
    const profiles = container.querySelector(
      '[data-testid="profile-management"]',
    );
    const defaults = container.querySelector('[data-testid="agent-defaults"]');
    if (!profiles || !defaults) {
      throw new Error('Expected Agent Profiles and Utility Agent sections');
    }
    expect(
      profiles.compareDocumentPosition(defaults) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(profiles.parentElement?.classList.contains('mb-4')).toBe(true);
    expect(mocks.init).toHaveBeenCalled();
    expect(mocks.llmInit).not.toHaveBeenCalled();
  });

  it('keeps Huabu-owned capabilities separate from Agent configuration', async () => {
    await renderModal();

    await act(async () => {
      findTab('settings.capabilities').click();
    });

    expect(container.textContent).toContain('settings.capabilitiesDescription');
    expect(
      container
        .querySelector('[data-testid="capability-sections"]')
        ?.classList.contains('space-y-4'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="capabilities-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).toBeNull();
    expect(mocks.llmInit).not.toHaveBeenCalled();
  });

  it('leaves only non-Agent preferences in General', async () => {
    await renderModal();

    await act(async () => {
      findTab('settings.general').click();
    });

    expect(
      container.querySelector('[data-testid="general-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-behavior"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="agent-runtime"]')).toBeNull();
    expect(container.querySelector('[data-testid="ocr-settings"]')).toBeNull();
  });
});

describe('Built-In Pi placement', () => {
  it('shows Built-In settings with the unified Agent surface when selected by default', async () => {
    mocks.profileId = 'huabu';
    await renderModal();

    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).not.toBeNull();
    expect(mocks.llmInit).toHaveBeenCalled();
  });

  it('preserves the focused Built-In repair visit without changing the default', async () => {
    mocks.requestedTab = 'builtIn';
    await renderModal();

    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).toBeNull();
    expect(mocks.init).not.toHaveBeenCalled();

    mocks.requestedTab = null;
    await renderModal(false);
    await renderModal();

    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).not.toBeNull();
  });
});
