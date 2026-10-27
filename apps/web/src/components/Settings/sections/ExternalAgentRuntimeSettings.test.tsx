// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getElectronBridge } from '@/hooks/useElectron';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

const {
  createConnectionCommand,
  getRuntimeConfig,
  updateRuntimeConfig,
  toast,
} = vi.hoisted(() => ({
  createConnectionCommand: vi.fn(),
  getRuntimeConfig: vi.fn(),
  updateRuntimeConfig: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/api/acp', () => ({
  createAgentletConnectionCommand: createConnectionCommand,
  getExternalAgentRuntimeConfig: getRuntimeConfig,
  updateExternalAgentRuntimeConfig: updateRuntimeConfig,
}));
vi.mock('@/components/Common/Toast', () => ({ toast }));
vi.mock('@/hooks/useElectron', () => ({ getElectronBridge: vi.fn() }));

import {
  AgentConnectionSettings,
  ExternalAgentRuntimeSettings,
} from './ExternalAgentRuntimeSettings';

import type {
  AgentletConnectionCommandResponse,
  DeploymentReadinessResponse,
  ExternalAgentRuntimeConfig,
} from '@huabu/shared';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const originalExecCommand = Object.getOwnPropertyDescriptor(
  document,
  'execCommand',
);
const content =
  "HUABU_PUBLIC_ORIGIN='https://huabu.example' HUABU_CONNECTION_TOKEN='secret' pnpm start:daemon --max-agents 10";
const loopbackReadiness: DeploymentReadinessResponse = {
  bind: { host: '127.0.0.1', scope: 'loopback' },
  access: { allowedHostsConfigured: false, basicAuthConfigured: false },
  owner: { policy: 'loopback-or-basic-auth', allowedForRequest: true },
  credentials: { writable: true, reason: 'available' },
  transport: { status: 'operator-unverified' },
  issues: [],
};
beforeEach(() => {
  vi.mocked(getElectronBridge).mockReturnValue(null);
  useDeploymentReadinessStore.setState({ readiness: null, error: null });
  getRuntimeConfig.mockResolvedValue({ idleTimeoutSecs: 600, maxAgents: 10 });
  updateRuntimeConfig.mockImplementation(
    async (config: ExternalAgentRuntimeConfig) => config,
  );
  createConnectionCommand.mockResolvedValue({
    content,
    source: 'environment',
    warnings: [],
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDeploymentReadinessStore.setState({ readiness: null, error: null });
  vi.clearAllMocks();
  if (originalExecCommand)
    Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});
async function render() {
  await act(async () =>
    root.render(
      <>
        <AgentConnectionSettings />
        <ExternalAgentRuntimeSettings />
      </>,
    ),
  );
}
function button(key: string) {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === key,
  );
  if (!found) throw new Error(`Button not found: ${key}`);
  return found;
}

function maxAgentsInput() {
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="settings.externalAgentMaxAgents"]',
  );
  if (!input) throw new Error('Maximum external agents input not found');
  return input;
}

async function editNumber(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Input value setter not found');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function editMaxAgents(value: string) {
  return editNumber(maxAgentsInput(), value);
}

function customMinutesInput() {
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="settings.customIdleTimeoutMinutes"]',
  );
  if (!input) throw new Error('Custom idle minutes input not found');
  return input;
}

async function chooseIdleTimeout(label: string) {
  const selector = container.querySelector<HTMLButtonElement>(
    '[aria-label="settings.externalAgentIdleTimeout"]',
  );
  if (!selector) throw new Error('Idle timeout selector not found');
  await act(async () => selector.click());
  const option = [...document.body.querySelectorAll('button')].find(
    (element) => element.textContent === label,
  );
  if (!option) throw new Error(`Idle timeout option not found: ${label}`);
  await act(async () => option.click());
}

async function blurCustomMinutes() {
  await act(async () => {
    customMinutesInput().dispatchEvent(
      new FocusEvent('focusout', { bubbles: true }),
    );
  });
}

async function blurMaxAgents() {
  await act(async () => {
    maxAgentsInput().dispatchEvent(
      new FocusEvent('focusout', { bubbles: true }),
    );
  });
}

describe('ExternalAgentRuntimeSettings', () => {
  it('shows setup guidance before copying when loopback readiness arrives', async () => {
    await render();
    expect(container.textContent).not.toContain(
      'settings.agentletLocalAccessSetup',
    );
    await act(async () =>
      useDeploymentReadinessStore.setState({ readiness: loopbackReadiness }),
    );
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toBe('settings.agentletLocalAccessSetup');
    expect(
      notice?.compareDocumentPosition(button('settings.agentletCommandCopy')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(button('settings.agentletCommandCopy').disabled).toBe(false);
    expect(createConnectionCommand).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the appropriate desktop guidance for an external server: %s',
    async (isRemoteServer) => {
      vi.mocked(getElectronBridge).mockReturnValue({
        isElectron: true,
        isRemoteServer,
        versions: { node: '24', chrome: '130', electron: '43' },
        platform: 'darwin',
        titleBarHeight: 32,
      });
      useDeploymentReadinessStore.setState({ readiness: loopbackReadiness });
      await render();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        isRemoteServer
          ? 'settings.agentletLocalAccessSetup'
          : 'settings.agentletDesktopLocalAccess',
      );
      expect(container.textContent).not.toContain(
        isRemoteServer
          ? 'settings.agentletDesktopLocalAccess'
          : 'settings.agentletLocalAccessSetup',
      );
      expect(createConnectionCommand).not.toHaveBeenCalled();
    },
  );

  it.each(['network', 'unknown', 'error'])(
    'does not show local-only guidance when readiness is %s',
    async (mode) => {
      useDeploymentReadinessStore.setState({
        readiness:
          mode === 'network'
            ? {
                ...loopbackReadiness,
                bind: { host: '0.0.0.0', scope: 'network' },
              }
            : null,
        error: mode === 'error' ? 'Readiness unavailable' : null,
      });
      await render();
      expect(container.textContent).not.toContain(
        'settings.agentletLocalAccessSetup',
      );
      expect(container.textContent).not.toContain(
        'settings.agentletDesktopLocalAccess',
      );
      expect(button('settings.agentletCommandCopy').disabled).toBe(false);
    },
  );

  it('saves custom idle minutes on blur without a permanent Save button', async () => {
    await render();
    await chooseIdleTimeout('settings.custom');
    expect(container.textContent).not.toContain('settings.saveChanges');
    await editNumber(customMinutesInput(), '25');
    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    await blurCustomMinutes();
    expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
      idleTimeoutSecs: 1500,
      maxAgents: 10,
    });
    expect(customMinutesInput().value).toBe('25');
    await blurCustomMinutes();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
  });

  it.each([1, 30, 1440])(
    'accepts %i custom minutes and keeps the editor open even for preset durations',
    async (minutes) => {
      await render();
      await chooseIdleTimeout('settings.custom');
      await editNumber(customMinutesInput(), String(minutes));
      await blurCustomMinutes();
      expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
        idleTimeoutSecs: minutes * 60,
        maxAgents: 10,
      });
      expect(customMinutesInput().value).toBe(String(minutes));
      expect(button('settings.custom').getAttribute('aria-expanded')).toBe(
        'false',
      );
    },
  );

  it.each(['', '0', '-1', '1.5', '1441'])(
    'rejects invalid custom minutes %j without losing the draft',
    async (minutes) => {
      await render();
      await chooseIdleTimeout('settings.custom');
      await editNumber(customMinutesInput(), minutes);
      await blurCustomMinutes();
      expect(updateRuntimeConfig).not.toHaveBeenCalled();
      expect(customMinutesInput().value).toBe(minutes);
      expect(customMinutesInput().getAttribute('aria-invalid')).toBe('true');
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'settings.customIdleTimeoutMinutesInvalid',
      );
      await editNumber(customMinutesInput(), '20');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await blurCustomMinutes();
      expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
        idleTimeoutSecs: 1200,
        maxAgents: 10,
      });
    },
  );

  it('does not save unchanged custom minutes after choosing Custom', async () => {
    await render();
    await chooseIdleTimeout('settings.custom');
    await blurCustomMinutes();
    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    await chooseIdleTimeout('settings.thirtyMinutes');
    await chooseIdleTimeout('settings.custom');
    expect(customMinutesInput().value).toBe('30');
    await blurCustomMinutes();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
  });

  it('preserves a failed custom duration and offers an inline retry without reverting to a preset', async () => {
    updateRuntimeConfig.mockRejectedValueOnce(new Error('custom save failed'));
    await render();
    await chooseIdleTimeout('settings.custom');
    await editNumber(customMinutesInput(), '30');
    await blurCustomMinutes();
    expect(customMinutesInput().value).toBe('30');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'custom save failed',
    );
    expect(customMinutesInput().disabled).toBe(false);
    await act(async () => button('settings.retrySave').click());
    expect(updateRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(customMinutesInput().value).toBe('30');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('guards custom Enter/blur duplicates and blocks concurrent process-limit writes', async () => {
    let resolve: ((config: ExternalAgentRuntimeConfig) => void) | undefined;
    updateRuntimeConfig.mockImplementationOnce(
      () =>
        new Promise<ExternalAgentRuntimeConfig>((done) => {
          resolve = done;
        }),
    );
    await render();
    await chooseIdleTimeout('settings.custom');
    await editNumber(customMinutesInput(), '25');
    await act(async () => {
      customMinutesInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      customMinutesInput().dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }),
      );
    });
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
    expect(customMinutesInput().disabled).toBe(true);
    expect(maxAgentsInput().disabled).toBe(true);
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
    if (!resolve) throw new Error('Save request did not start');
    await act(async () => resolve?.({ idleTimeoutSecs: 1500, maxAgents: 10 }));
    await blurCustomMinutes();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
    await editMaxAgents('15');
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenLastCalledWith({
      idleTimeoutSecs: 1500,
      maxAgents: 15,
    });
    await editNumber(customMinutesInput(), '26');
    await blurCustomMinutes();
    expect(updateRuntimeConfig).toHaveBeenLastCalledWith({
      idleTimeoutSecs: 1560,
      maxAgents: 15,
    });
  });

  it('still restores the prior preset and reports a failed preset save', async () => {
    updateRuntimeConfig.mockRejectedValueOnce(new Error('preset save failed'));
    await render();
    await chooseIdleTimeout('settings.thirtyMinutes');
    expect(button('settings.tenMinutesDefault')).toBeDefined();
    expect(toast).toHaveBeenCalledWith('preset save failed', {
      tone: 'danger',
    });
  });

  it('saves the process limit on blur, not during typing, without a Save button', async () => {
    await render();
    expect(container.textContent).not.toContain('settings.saveChanges');
    await editMaxAgents('12');
    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
      idleTimeoutSecs: 600,
      maxAgents: 12,
    });
    expect(maxAgentsInput().value).toBe('12');
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
  });

  it('saves on Enter and does not duplicate the following blur or repeated Enter', async () => {
    let resolve: ((config: ExternalAgentRuntimeConfig) => void) | undefined;
    updateRuntimeConfig.mockImplementationOnce(
      () =>
        new Promise<ExternalAgentRuntimeConfig>((done) => {
          resolve = done;
        }),
    );
    await render();
    await editMaxAgents('15');
    await act(async () => {
      maxAgentsInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      maxAgentsInput().dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }),
      );
      maxAgentsInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
    expect(maxAgentsInput().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'settings.saving',
    );
    if (!resolve) throw new Error('Save request did not start');
    await act(async () => resolve?.({ idleTimeoutSecs: 600, maxAgents: 15 }));
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenCalledOnce();
    expect(maxAgentsInput().disabled).toBe(false);
  });

  it.each(['', '0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)])(
    'keeps invalid draft %j visible without submitting it',
    async (value) => {
      await render();
      await editMaxAgents(value);
      await blurMaxAgents();
      expect(updateRuntimeConfig).not.toHaveBeenCalled();
      expect(maxAgentsInput().value).toBe(value);
      expect(maxAgentsInput().getAttribute('aria-invalid')).toBe('true');
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'settings.externalAgentMaxAgentsInvalid',
      );
      await editMaxAgents('20');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await blurMaxAgents();
      expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
        idleTimeoutSecs: 600,
        maxAgents: 20,
      });
    },
  );

  it('accepts the safe-integer upper boundary without adding a product maximum', async () => {
    await render();
    await editMaxAgents(String(Number.MAX_SAFE_INTEGER));
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenCalledExactlyOnceWith({
      idleTimeoutSecs: 600,
      maxAgents: Number.MAX_SAFE_INTEGER,
    });
  });

  it('preserves a failed draft, shows a field error and retries explicitly', async () => {
    updateRuntimeConfig.mockRejectedValueOnce(new Error('unable to save'));
    await render();
    await editMaxAgents('18');
    await blurMaxAgents();
    expect(maxAgentsInput().value).toBe('18');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'unable to save',
    );
    expect(maxAgentsInput().disabled).toBe(false);
    await act(async () => button('settings.retrySave').click());
    expect(updateRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(updateRuntimeConfig).toHaveBeenLastCalledWith({
      idleTimeoutSecs: 600,
      maxAgents: 18,
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('settings.retrySave');
  });

  it('never writes unchanged values or fallback defaults after a failed load', async () => {
    await render();
    await blurMaxAgents();
    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    getRuntimeConfig.mockRejectedValueOnce(new Error('load failed'));
    await render();
    expect(maxAgentsInput().disabled).toBe(true);
    await editMaxAgents('22');
    await blurMaxAgents();
    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('load failed', { tone: 'danger' });
  });

  it('preserves the latest acknowledged value of the other runtime setting', async () => {
    await render();
    await editMaxAgents('12');
    await blurMaxAgents();
    await act(async () => button('settings.tenMinutesDefault').click());
    const option = [...document.body.querySelectorAll('button')].find(
      (element) => element.textContent === 'settings.thirtyMinutes',
    );
    if (!option) throw new Error('Thirty-minute option not found');
    await act(async () => option.click());
    expect(updateRuntimeConfig).toHaveBeenLastCalledWith({
      idleTimeoutSecs: 1800,
      maxAgents: 12,
    });
    await editMaxAgents('14');
    await blurMaxAgents();
    expect(updateRuntimeConfig).toHaveBeenLastCalledWith({
      idleTimeoutSecs: 1800,
      maxAgents: 14,
    });
  });

  it('loads runtime configuration only for runtime controls, not connection instructions', async () => {
    await act(async () => root.render(<AgentConnectionSettings />));
    expect(container.textContent).toContain(
      'settings.agentletHowToConnectDescription',
    );
    expect(container.textContent).not.toContain(
      'settings.externalAgentIdleTimeout',
    );
    expect(getRuntimeConfig).not.toHaveBeenCalled();

    await act(async () => root.render(<ExternalAgentRuntimeSettings />));
    expect(container.textContent).not.toContain(
      'settings.agentletHowToConnectDescription',
    );
    expect(container.textContent).toContain(
      'settings.externalAgentIdleTimeout',
    );
    expect(getRuntimeConfig).toHaveBeenCalledOnce();
  });
  it('shows three readable steps and keeps optional instructions collapsed without revealing credentials', async () => {
    await render();
    expect(container.textContent).toContain(
      'settings.agentletHowToConnectDescription',
    );
    expect(container.textContent).toContain('git clone');
    expect(container.textContent).toContain('pnpm install');
    const preparation = container.querySelector('ol > li');
    expect(
      [...(preparation?.querySelectorAll('p') ?? [])].map(
        (paragraph) => paragraph.textContent,
      ),
    ).toEqual([
      'settings.agentletRequirements',
      'settings.agentletSourceSetup',
    ]);
    expect(container.textContent).not.toContain(
      'settings.agentletGeneratedTokenWarning',
    );
    expect(container.textContent).toContain(
      'settings.agentletConnectionTokenSecurityInfo',
    );
    expect(
      [...container.querySelectorAll('ol > li h4')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      'settings.agentletPrepareDevice',
      'settings.agentletRunConnection',
      'settings.agentletCheckConnection',
    ]);
    expect(
      container
        .querySelector('ol')
        ?.parentElement?.classList.contains('text-[13px]'),
    ).toBe(true);
    expect(
      container
        .querySelector('ol')
        ?.parentElement?.classList.contains('leading-6'),
    ).toBe(true);
    expect(
      button('settings.agentletOtherConnectionOptions').getAttribute(
        'aria-expanded',
      ),
    ).toBe('false');
    expect(container.textContent).not.toContain(
      'settings.agentletEnvFileInstructions',
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('#agentlet-connection-token')).toBeNull();
    expect(container.textContent).not.toContain('secret');
    expect(createConnectionCommand).not.toHaveBeenCalled();
    const controls = button('settings.agentletCommandCopy').parentElement;
    expect(controls?.classList.contains('flex-wrap')).toBe(true);
    expect(controls?.classList.contains('w-full')).toBe(true);
    await act(async () =>
      button('settings.agentletOtherConnectionOptions').click(),
    );
    expect(
      button('settings.agentletOtherConnectionOptions').getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
    expect(container.textContent).toContain(
      'settings.agentletEnvFileInstructions',
    );
    const detailsId = button(
      'settings.agentletOtherConnectionOptions',
    ).getAttribute('aria-controls');
    expect(
      [...container.querySelectorAll(`[id="${detailsId}"] > p`)].map(
        (paragraph) => paragraph.textContent,
      ),
    ).toEqual(['settings.agentletEnvFileInstructions']);
    expect(container.textContent).toContain(
      'pnpm start:daemon --env-file ./connection.env',
    );
    expect(container.textContent).not.toContain(
      'settings.agentletStableConnection',
    );
    expect(createConnectionCommand).not.toHaveBeenCalled();
  });

  it('preserves the process limit when saving idle timeout', async () => {
    await render();
    await act(async () => button('settings.tenMinutesDefault').click());
    const selected = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'settings.thirtyMinutes',
    );
    if (!selected) throw new Error('Thirty-minute option not found');
    await act(async () => selected.click());
    expect(updateRuntimeConfig).toHaveBeenCalledWith({
      idleTimeoutSecs: 1800,
      maxAgents: 10,
    });
    expect(toast).toHaveBeenCalledWith(
      'settings.externalAgentIdleTimeoutSaved',
      { tone: 'success' },
    );
  });

  it.each([
    [
      'settings.agentletCommandCopy',
      'command',
      'settings.agentletCommandCopied',
    ],
    [
      'settings.agentletEnvFileCopy',
      'env-file',
      'settings.agentletEnvFileCopied',
    ],
  ])(
    'copies only on explicit action without rendering returned secret text',
    async (key, format, copied) => {
      await render();
      if (format === 'env-file') {
        await act(async () =>
          button('settings.agentletOtherConnectionOptions').click(),
        );
      }
      await act(async () => button(key).click());
      expect(createConnectionCommand).toHaveBeenCalledWith('posix', format);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content);
      expect(container.textContent).not.toContain('secret');
      expect(container.textContent).not.toContain('https://huabu.example');
      expect(toast).toHaveBeenCalledWith(copied, { tone: 'success' });
    },
  );

  it.each(['command', 'env-file'] as const)(
    'uses the explicit PowerShell choice for %s instead of browser platform inference',
    async (format) => {
      await render();
      const selector = container.querySelector<HTMLButtonElement>(
        '[aria-label="settings.agentletTargetShell"]',
      );
      if (!selector) throw new Error('Shell selector not found');
      await act(async () => selector.click());
      const powershell = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'PowerShell',
      );
      if (!powershell) throw new Error('PowerShell choice not found');
      await act(async () => powershell.click());
      if (format === 'env-file') {
        await act(async () =>
          button('settings.agentletOtherConnectionOptions').click(),
        );
      }
      await act(async () =>
        button(
          format === 'command'
            ? 'settings.agentletCommandCopy'
            : 'settings.agentletEnvFileCopy',
        ).click(),
      );
      expect(createConnectionCommand).toHaveBeenCalledWith(
        'powershell',
        format,
      );
    },
  );

  it.each([
    ['generated', [], 'settings.agentletCommandCopiedGenerated'],
    ['environment', ['loopback'], 'settings.agentletCommandCopiedLoopback'],
    [
      'environment',
      ['insecure', 'loopback'],
      'settings.agentletCommandCopiedLoopback',
    ],
    ['generated', ['insecure'], 'settings.agentletCommandCopiedGenerated'],
  ])(
    'preserves generated-token and loopback guidance regardless of transport',
    async (source, warnings, key) => {
      createConnectionCommand.mockResolvedValue({ content, source, warnings });
      await render();
      await act(async () => button('settings.agentletCommandCopy').click());
      expect(toast).toHaveBeenCalledWith(key, { tone: 'warning' });
    },
  );

  it.each(['command', 'env-file'] as const)(
    'copies %s over unencrypted transport without inline or toast warnings',
    async (format) => {
      createConnectionCommand.mockResolvedValue({
        content,
        source: 'environment',
        warnings: ['insecure'],
      });
      await render();
      if (format === 'env-file') {
        await act(async () =>
          button('settings.agentletOtherConnectionOptions').click(),
        );
      }
      await act(async () =>
        button(
          format === 'command'
            ? 'settings.agentletCommandCopy'
            : 'settings.agentletEnvFileCopy',
        ).click(),
      );
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content);
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        format === 'command'
          ? 'settings.agentletCommandCopied'
          : 'settings.agentletEnvFileCopied',
        { tone: 'success' },
      );
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).not.toContain('secret');
    },
  );

  it('copies a managed token without temporary-key warnings or rendering credentials', async () => {
    createConnectionCommand.mockResolvedValue({
      content,
      source: 'managed',
      warnings: [],
    });
    await render();
    await act(async () => button('settings.agentletCommandCopy').click());
    expect(toast).toHaveBeenCalledWith('settings.agentletCommandCopied', {
      tone: 'success',
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('secret');
  });

  it('shows actionable connection guidance without transport warnings or copied content', async () => {
    createConnectionCommand.mockResolvedValue({
      content,
      source: 'generated',
      warnings: ['insecure', 'loopback'],
    });
    await act(async () => root.render(<AgentConnectionSettings />));
    await act(async () => button('settings.agentletCommandCopy').click());
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(
      'settings.agentletGeneratedTokenWarning',
    );
    expect(status?.textContent).toContain('settings.agentletLoopbackWarning');
    expect(status?.textContent).not.toContain(
      'settings.agentletInsecureWarning',
    );
    expect(container.textContent).not.toContain('secret');
    expect(container.textContent).not.toContain('https://huabu.example');
  });

  it('disables both copy actions and the terminal selector while copying', async () => {
    let resolve:
      | ((result: AgentletConnectionCommandResponse) => void)
      | undefined;
    createConnectionCommand.mockImplementationOnce(
      () =>
        new Promise<AgentletConnectionCommandResponse>((done) => {
          resolve = done;
        }),
    );
    await act(async () => root.render(<AgentConnectionSettings />));
    await act(async () =>
      button('settings.agentletOtherConnectionOptions').click(),
    );
    await act(async () => button('settings.agentletCommandCopy').click());
    expect(button('settings.agentletCommandCopying').disabled).toBe(true);
    expect(button('settings.agentletEnvFileCopy').disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="settings.agentletTargetShell"]',
      )?.disabled,
    ).toBe(true);
    await act(async () =>
      resolve?.({ content, source: 'environment', warnings: [] }),
    );
    expect(button('settings.agentletCommandCopy').disabled).toBe(false);
    expect(button('settings.agentletEnvFileCopy').disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content);
  });

  it('reports HTTP/clipboard failure explicitly and re-enables both copy actions', async () => {
    createConnectionCommand.mockRejectedValueOnce(
      new Error('copy endpoint failed'),
    );
    await render();
    await act(async () => button('settings.agentletCommandCopy').click());
    expect(toast).toHaveBeenCalledWith('copy endpoint failed', {
      tone: 'danger',
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error('clipboard blocked'),
    );
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('clipboard blocked');
      }),
    });
    await act(async () =>
      button('settings.agentletOtherConnectionOptions').click(),
    );
    await act(async () => button('settings.agentletEnvFileCopy').click());
    expect(toast).toHaveBeenCalledWith('clipboard blocked', { tone: 'danger' });
    expect(button('settings.agentletCommandCopy').disabled).toBe(false);
    expect(button('settings.agentletEnvFileCopy').disabled).toBe(false);
    expect(container.textContent).not.toContain('secret');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
