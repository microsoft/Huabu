// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';

import { ConnectedDeviceRow } from './ConnectedDeviceRow';

import type { AcpAgentletDiscoveryResponse } from '@huabu/shared';

const api = vi.hoisted(() => ({ discover: vi.fn(), refresh: vi.fn() }));
vi.mock('@/api/acp', () => ({ discoverAcpAgentlet: api.discover }));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: { refresh: typeof api.refresh }) => unknown,
  ) => selector({ refresh: api.refresh }),
}));
vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: en } = await import('@/i18n/resources/en/common.json');
  const instance = createInstance();
  await instance.init({ lng: 'en', resources: { en: { translation: en } } });
  return { useTranslation: () => ({ t: instance.getFixedT('en') }) };
});

const device = {
  agentletId: 'device-a',
  displayName: 'Machine: linux x64',
  version: '1.0',
  profileCount: 1,
  connectedAt: '2026-01-01T00:00:00.000Z',
};
const entry = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  status: 'ready' as const,
  capabilities: { autoApprove: true, customLaunchCommand: false },
  installHint: 'Install Copilot',
};
const result: AcpAgentletDiscoveryResponse = {
  agentletId: device.agentletId,
  harnesses: [
    { ...entry, profileStatus: 'existing', profileId: 'old' },
    {
      ...entry,
      id: 'gemini',
      displayName: 'Gemini',
      profileStatus: 'created',
      profileId: 'new',
    },
    {
      ...entry,
      id: 'claude',
      displayName: 'Claude',
      status: 'adapter-missing',
      profileStatus: 'skipped',
      installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
    },
    {
      ...entry,
      id: 'codex',
      displayName: 'Codex',
      status: 'not-found',
      profileStatus: 'skipped',
    },
    {
      ...entry,
      id: 'qwen',
      displayName: 'Qwen',
      profileStatus: 'skipped',
      diagnostics: [{ code: 'workspace_failed', message: 'Permission denied' }],
    },
  ],
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.discover.mockReset().mockResolvedValue(result);
  api.refresh.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(local = false) {
  await act(async () =>
    root.render(
      <ConnectedDeviceRow
        device={device}
        isLocalDevice={local}
        connectionControls={local ? <span>Disconnect</span> : null}
      />,
    ),
  );
}
function detectionButton() {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Detect installed Agents on"]',
  );
  if (!button) throw new Error('Expected the device detection button');
  return button;
}
function detailsButton() {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === 'Detection details',
  );
  if (!button) throw new Error('Expected the detection details button');
  return button;
}

describe('per-device installed Agent detection', () => {
  it('blocks same-tick duplicate clicks and keeps pending feedback through snapshot publication', async () => {
    let finishDetection!: (value: AcpAgentletDiscoveryResponse) => void;
    let finishRefresh!: () => void;
    api.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDetection = resolve;
        }),
    );
    api.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    await render();
    await act(async () => {
      detectionButton().click();
      detectionButton().click();
    });
    expect(api.discover).toHaveBeenCalledExactlyOnceWith(device.agentletId);
    expect(detectionButton().disabled).toBe(true);
    expect(container.textContent).toContain('Detecting installed Agents');
    await act(async () => finishDetection(result));
    expect(api.refresh).toHaveBeenCalledExactlyOnceWith({
      afterMutation: true,
    });
    expect(detectionButton().disabled).toBe(true);
    await act(async () => finishRefresh());
    expect(detectionButton().disabled).toBe(false);
  });

  it('shows exact summary counts, workspace warning and actionable adapter guidance', async () => {
    await render();
    await act(async () => detectionButton().click());
    expect(container.textContent).toContain(
      'Agent types ready: 3. Automatic Profiles: 1 existing, 1 new. Missing ACP adapters: 1; not found: 1.',
    );
    expect(container.textContent).toContain(
      '1 ready Agent could not get a default working folder',
    );
    const details = detailsButton();
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await act(async () => details.click());
    expect(container.textContent).toContain(
      'Native CLI found; ACP adapter missing',
    );
    expect(container.querySelector('code')?.textContent).toBe(
      'npm install -g @agentclientprotocol/claude-agent-acp',
    );
    expect(container.textContent).toContain(
      'To use this Agent, install on this device, then detect again',
    );
    expect(details.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not hide adapter diagnostics when no Profile was added', async () => {
    api.discover.mockResolvedValueOnce({
      ...result,
      harnesses: [result.harnesses[2]],
    });
    await render();
    await act(async () => detectionButton().click());
    expect(container.textContent).toContain('0 new. Missing ACP adapters: 1');
  });

  it('preserves lookup/version warnings and safely handles unknown diagnostic codes', async () => {
    api.discover.mockResolvedValueOnce({
      ...result,
      harnesses: [
        {
          ...entry,
          status: 'not-found',
          profileStatus: 'skipped',
          diagnostics: [
            { code: 'lookup_failed', message: 'lookup failed' },
            { code: 'version_probe_failed', message: 'unknown version' },
            { code: 'toString', message: 'unknown diagnostic' },
          ],
        },
      ],
    });
    await render();
    await act(async () => detectionButton().click());
    const details = detailsButton();
    await act(async () => details.click());
    expect(container.textContent).toContain(
      'PATH lookup failed; installation could not be confirmed',
    );
    expect(container.textContent).toContain(
      'Version unavailable; command readiness is unchanged',
    );
    expect(container.textContent).toContain(
      'Agentlet reported an additional detection diagnostic',
    );
  });

  it('keeps local connection controls and identity alongside the detection action', async () => {
    await render(true);
    expect(container.textContent).toContain('(This device)');
    expect(container.textContent).toContain('Disconnect');
    expect(detectionButton().getAttribute('aria-label')).toContain(
      device.displayName,
    );
    expect(api.discover).not.toHaveBeenCalled();
  });

  it.each([
    ['harness_discovery_stale', 409, 'device connection changed'],
    ['harness_discovery_unsupported', 503, 'Update Agentlet'],
    ['harness_discovery_unavailable', 503, 'detection is unavailable'],
    ['agentlet_unavailable', 409, 'no longer connected'],
    ['forbidden', 403, 'Owner authorization'],
  ])('reports %s and allows explicit retry', async (code, status, text) => {
    api.discover.mockRejectedValueOnce(
      new ApiError(
        Number(status),
        { code: String(code), message: 'private upstream message' },
        'fallback',
      ),
    );
    await render();
    await act(async () => detectionButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      String(text),
    );
    expect(container.textContent).not.toContain('private upstream message');
    expect(detectionButton().disabled).toBe(false);
    await act(async () => detectionButton().click());
    expect(api.discover).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports partial creation and refreshes shared state after reconciliation failure', async () => {
    api.discover.mockRejectedValueOnce(
      new ApiError(
        500,
        {
          code: 'harness_reconciliation_failed',
          details: { createdProfileIds: ['saved-1', 'saved-2'] },
        },
        'failed',
      ),
    );
    await render();
    await act(async () => detectionButton().click());
    expect(container.textContent).toContain(
      '2 new Profiles were saved before the failure',
    );
    expect(api.refresh).toHaveBeenCalledExactlyOnceWith({
      afterMutation: true,
    });
  });

  it('distinguishes a failed list refresh from a successful detection', async () => {
    api.refresh.mockRejectedValueOnce(new Error('network'));
    await render();
    await act(async () => detectionButton().click());
    expect(container.textContent).toContain('Agent types ready: 3');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not refresh the shared Profile list',
    );
    expect(detectionButton().disabled).toBe(false);
  });

  it('does not publish an old row result into a remounted device row', async () => {
    let finish!: (value: AcpAgentletDiscoveryResponse) => void;
    api.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await act(async () => detectionButton().click());
    await act(async () => root.render(null));
    await render();
    await act(async () => finish(result));
    expect(container.textContent).not.toContain('Agent types ready');
    expect(detectionButton().disabled).toBe(false);
    expect(api.refresh).toHaveBeenCalledOnce();
  });
});
