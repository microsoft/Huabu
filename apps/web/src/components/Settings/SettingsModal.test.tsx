// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsModal } from './SettingsModal';

import type { Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  load: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useElectron', () => ({
  getElectronBridge: () => undefined,
}));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: { init: typeof mocks.init }) => unknown,
  ) => selector({ init: mocks.init }),
}));
vi.mock('@/store/llmStore', () => ({
  useLLMStore: (selector: (state: { init: typeof mocks.init }) => unknown) =>
    selector({ init: mocks.init }),
}));
vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (
    selector: (state: { load: typeof mocks.load }) => unknown,
  ) => selector({ load: mocks.load }),
}));
vi.mock('@/store/settingsUiStore', () => ({
  useSettingsUiStore: (
    selector: (state: {
      requestedTab: null;
      clearRequestedTab: typeof mocks.clear;
    }) => unknown,
  ) => selector({ requestedTab: null, clearRequestedTab: mocks.clear }),
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
vi.mock('./sections/GeneralSettings', () => ({
  GeneralSettings: () => null,
}));
vi.mock('./sections/LLMSettings', () => ({
  LLMSettings: () => <div data-testid="legacy-llm" />,
}));
vi.mock('./sections/ImageProviderSettings', () => ({
  ImageProviderSettings: () => null,
}));
vi.mock('./sections/IntegrationsSettings', () => ({
  IntegrationsSettings: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Settings default Agent placement', () => {
  it('shows defaults only under Huabu Agent while retaining legacy providers and external Profile management', async () => {
    await act(async () => {
      root.render(<SettingsModal isOpen onClose={vi.fn()} />);
    });
    expect(
      container.querySelectorAll('[data-testid="agent-defaults"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="legacy-llm"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).toBeNull();

    const tabs = [...container.querySelectorAll('nav button')];
    const externalTab = tabs.find(
      (tab) => tab.textContent === 'settings.externalAgents',
    ) as HTMLButtonElement;
    await act(async () => externalTab.click());
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).not.toBeNull();

    const huabuTab = tabs.find(
      (tab) => tab.textContent === 'settings.huabuAgent',
    ) as HTMLButtonElement;
    await act(async () => huabuTab.click());
    expect(
      container.querySelectorAll('[data-testid="agent-defaults"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="legacy-llm"]'),
    ).not.toBeNull();
  });
});
