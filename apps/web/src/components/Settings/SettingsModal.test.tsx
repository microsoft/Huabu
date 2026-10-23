// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsModal } from './SettingsModal';

import type { ExternalAgentsNavigation } from './agent-profiles/ExternalAgentsSettings';
import type { Root } from 'react-dom/client';

type RequestedTab = 'builtIn' | 'services' | null;

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
  AgentDefaultsSettings: () => (
    <section>
      <h4>settings.agentDefaultsTitle</h4>
      <div data-testid="agent-defaults" />
    </section>
  ),
}));
vi.mock('./agent-profiles/ExternalAgentsSettings', () => ({
  ExternalAgentsSettings: ({
    onNavigationChange,
  }: {
    onNavigationChange: (navigation: ExternalAgentsNavigation | null) => void;
  }) => {
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <div data-testid="profile-management">
        <h4>settings.connectedDevices</h4>
        <h4>settings.agentProfiles</h4>
        <button
          ref={trigger}
          onClick={() =>
            onNavigationChange({
              title: 'settings.addDevice',
              onBack: () => {
                onNavigationChange(null);
                trigger.current?.focus();
              },
            })
          }
        >
          settings.addDevice
        </button>
      </div>
    );
  },
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
vi.mock('./sections/ServicesSettings', () => ({
  ServicesSettings: () => <div data-testid="services-settings" />,
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

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent === label ||
      candidate.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

describe('Settings information architecture', () => {
  it('keeps navigation and version above the scrollable form on narrow screens', async () => {
    await renderModal();
    const dialog = container.querySelector('[role="dialog"]');
    const navigation = dialog?.querySelector('nav');
    expect(dialog?.classList.contains('flex-col')).toBe(true);
    expect(dialog?.classList.contains('sm:flex-row')).toBe(true);
    expect(navigation?.classList.contains('grid-cols-3')).toBe(true);
    expect(navigation?.classList.contains('sm:w-48')).toBe(true);
    expect(navigation?.querySelector('span.select-text')).not.toBeNull();
    expect(
      container
        .querySelector('header')
        ?.parentElement?.classList.contains('min-h-0'),
    ).toBe(true);
  });

  it('vertically centers both titles on matching header centerlines', async () => {
    await renderModal();
    const title = container.querySelector('nav h2');
    expect(title?.classList.contains('h-7')).toBe(true);
    expect(title?.classList.contains('items-center')).toBe(true);
    expect(container.querySelector('nav')?.classList.contains('py-3')).toBe(
      true,
    );
    const header = container.querySelector('header');
    expect(header?.classList.contains('h-[52px]')).toBe(true);
    expect(header?.classList.contains('items-center')).toBe(true);
  });

  it('starts content below the header with responsive side padding', async () => {
    await renderModal();
    for (const label of [
      'settings.agent',
      'settings.services',
      'settings.general',
    ]) {
      await act(async () => findTab(label).click());
      const content = container.querySelector('header')?.nextElementSibling;
      expect(content?.classList.contains('overflow-y-auto')).toBe(true);
      expect(content?.classList.contains('pt-0')).toBe(true);
      expect(content?.classList.contains('pb-4')).toBe(true);
      expect(content?.classList.contains('px-4')).toBe(true);
      expect(content?.classList.contains('sm:px-5')).toBe(true);
      expect(content?.classList.contains('py-4')).toBe(false);
    }
  });

  it('uses a subtle 16px close icon inside a 28px target and preserves dismissal', async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(<SettingsModal isOpen onClose={onClose} />),
    );
    const close = container.querySelector<HTMLButtonElement>(
      '[aria-label="actions.close"]',
    );
    expect(close?.classList.contains('h-7')).toBe(true);
    expect(close?.classList.contains('w-7')).toBe(true);
    expect(close?.classList.contains('text-fg-subtle')).toBe(true);
    expect(close?.querySelector('svg')?.getAttribute('width')).toBe('16');
    if (!close) throw new Error('Missing close action');
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the content header free of a bottom divider across settings pages', async () => {
    await renderModal();
    for (const label of [
      'settings.agent',
      'settings.services',
      'settings.general',
    ]) {
      await act(async () => findTab(label).click());
      expect(
        container.querySelector('header')?.classList.contains('border-b'),
      ).toBe(false);
    }
  });

  it('uses text-only navigation with rounded full-row selection and preserves tab order', async () => {
    await renderModal();
    const tabs = [...container.querySelectorAll('nav button')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'settings.agent',
      'settings.services',
      'settings.general',
    ]);
    for (const tab of tabs) {
      expect(tab.querySelector('svg')).toBeNull();
      expect(tab.classList.contains('rounded-md')).toBe(true);
      expect(tab.classList.contains('min-h-8')).toBe(true);
      expect(tab.classList.contains('text-[13px]')).toBe(true);
      expect(tab.classList.contains('px-2')).toBe(true);
      expect(tab.classList.contains('py-0')).toBe(true);
      expect(tab.classList.contains('border-l-2')).toBe(false);
    }
    expect(
      findTab('settings.agent').classList.contains('bg-sidebar-selected'),
    ).toBe(true);
    expect(
      findTab('settings.agent').classList.contains(
        'enabled:hover:bg-sidebar-selected',
      ),
    ).toBe(true);
    expect(
      container.querySelector('nav')?.classList.contains('bg-sidebar'),
    ).toBe(true);
    expect(container.querySelector('nav')?.classList.contains('gap-0.5')).toBe(
      true,
    );
    await act(async () => findTab('settings.general').click());
    expect(findTab('settings.general').getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      findTab('settings.general').classList.contains('bg-sidebar-selected'),
    ).toBe(true);
    expect(
      findTab('settings.agent').classList.contains('bg-sidebar-selected'),
    ).toBe(false);
    expect(container.querySelector('nav')?.textContent).toContain('v');
  });

  it('uses the visible window chrome height for the backdrop inset', async () => {
    await renderModal();

    const overlay =
      container.querySelector<HTMLElement>('[role="dialog"]')?.parentElement;
    expect(
      overlay?.classList.contains('top-[var(--window-chrome-height,0px)]'),
    ).toBe(true);
  });

  it('puts external Agents first and keeps behavior, runtime, and Built-In sections collapsed', async () => {
    await renderModal();

    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-behavior"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="agent-runtime"]')).toBeNull();
    expect(
      [...container.querySelectorAll('h4, button[aria-expanded]')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      'settings.connectedDevices',
      'settings.agentProfiles',
      'settings.agentDefaultsTitle',
      'settings.agentBehavior',
      'settings.externalAgentRuntime',
      'settings.builtInPi',
    ]);
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
    expect(findButton('settings.builtInPi').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(
      container.querySelector('[aria-label="settings.builtInPiConfigure"]'),
    ).toBeNull();

    const behaviorHeading = findButton('settings.agentBehavior');
    expect(behaviorHeading.getAttribute('aria-expanded')).toBe('false');
    await act(async () => behaviorHeading.click());
    expect(behaviorHeading.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      findButton('settings.externalAgentRuntime').click();
    });
    const behavior = container.querySelector('[data-testid="agent-behavior"]');
    const runtime = container.querySelector('[data-testid="agent-runtime"]');
    if (!behavior || !runtime) {
      throw new Error('Expected behavior and runtime controls');
    }
    expect(
      defaults.compareDocumentPosition(behavior) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      behavior.compareDocumentPosition(runtime) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () => behaviorHeading.click());
    expect(behaviorHeading.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="agent-behavior"]')).toBe(
      behavior,
    );
    expect(behavior.parentElement?.hidden).toBe(true);
    expect(container.querySelector('[data-testid="agent-runtime"]')).toBe(
      runtime,
    );
    await act(async () => behaviorHeading.click());
    expect(container.querySelector('[data-testid="agent-behavior"]')).toBe(
      behavior,
    );
    expect(behavior.parentElement?.hidden).toBe(false);
  });

  it('keeps Huabu-managed services separate from Agent configuration', async () => {
    await renderModal();

    await act(async () => {
      findTab('settings.services').click();
    });

    expect(container.textContent).toContain('settings.servicesDescription');
    expect(
      container
        .querySelector('[data-testid="service-sections"]')
        ?.classList.contains('gap-3'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="services-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="profile-management"]'),
    ).toBeNull();
    expect(mocks.llmInit).not.toHaveBeenCalled();
  });

  it('uses the shared focused-view header for adding a device without stealing return focus', async () => {
    await renderModal();
    const trigger = findButton('settings.addDevice');
    await act(async () => trigger.click());
    expect(container.querySelector('header h3')?.textContent).toBe(
      'settings.addDevice',
    );
    expect(document.activeElement).toBe(container.querySelector('header h3'));
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="agent-behavior"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(
      'settings.builtInPiConfiguration',
    );

    const back = container.querySelector<HTMLButtonElement>(
      '[aria-label="settings.backToAgents"]',
    );
    if (!back) throw new Error('Missing shared Back control');
    await act(async () => back.click());
    expect(document.activeElement).toBe(trigger);
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(container.querySelector('header h3')?.textContent).toBe(
      'settings.agent',
    );
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
  it('opens Built-In configuration only on demand even when it is the Utility Agent', async () => {
    mocks.profileId = 'huabu';
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
    expect(mocks.llmInit).not.toHaveBeenCalled();
    await act(async () => findButton('settings.builtInPi').click());
    await act(async () => {
      findButton('settings.builtInPiConfigure').click();
    });
    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).toBeNull();
    expect(mocks.llmInit).toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('header h3'));
    const back = container.querySelector<HTMLButtonElement>(
      '[title="settings.backToAgents"], [aria-label="settings.backToAgents"]',
    );
    if (!back) throw new Error('Expected back to Agents control');
    await act(async () => back.click());
    expect(
      container.querySelector('[data-testid="built-in-settings"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="agent-defaults"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('header h3'));
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
