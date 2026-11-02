// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDetectedClis } from './useDetectedClis';

import type { AcpAgentCliInfo } from '@huabu/shared';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listAgentClis: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/components/Common/Toast', () => ({ toast: apiMocks.toast }));

vi.mock('@/api/acp', () => ({
  createAcpProfile: vi.fn(),
  listAcpAgentClis: apiMocks.listAgentClis,
  updateAcpProfile: vi.fn(),
}));

function Harness({
  enabled,
  profileId,
  connectionKey,
}: {
  enabled: boolean;
  profileId?: string;
  connectionKey?: string;
}) {
  const { detectedClis, loaded, error, recheck } = useDetectedClis(
    enabled,
    profileId ? { profileId } : { agentletId: 'local-device' },
    connectionKey,
  );
  return (
    <span data-error={error}>
      {loaded ? 'loaded' : 'idle'}:{detectedClis.length}
      <button aria-label="Recheck" onClick={recheck} />
    </span>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const detectedAgent: AcpAgentCliInfo = {
  id: 'copilot',
  displayName: 'Copilot',
  status: 'ready',
  installHint: 'Install Copilot',
  capabilities: { autoApprove: true, customLaunchCommand: false },
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  apiMocks.listAgentClis.mockReset();
  apiMocks.toast.mockReset();
});

describe('useDetectedClis', () => {
  it('defers CLI probing until the editor opens', async () => {
    apiMocks.listAgentClis.mockResolvedValueOnce({
      agents: [detectedAgent],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<Harness enabled={false} />));
    expect(apiMocks.listAgentClis).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<Harness enabled />);
      await Promise.resolve();
    });

    expect(apiMocks.listAgentClis).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('loaded:1');
  });

  it('does not reuse a cached catalogue when Settings mounts again', async () => {
    apiMocks.listAgentClis.mockResolvedValue({ agents: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));
    act(() => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));

    expect(apiMocks.listAgentClis).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('loaded:0');
  });

  it('clears stale detection and reports failure while allowing manual setup', async () => {
    apiMocks.listAgentClis
      .mockResolvedValueOnce({ agents: [detectedAgent] })
      .mockRejectedValueOnce(new Error('Daemon unavailable'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));
    expect(container.textContent).toBe('loaded:1');

    await act(async () => window.dispatchEvent(new Event('workspace-changed')));

    expect(container.textContent).toBe('loaded:0');
    expect(apiMocks.toast).toHaveBeenCalledWith('Daemon unavailable', {
      tone: 'danger',
    });
    expect(container.querySelector('span')?.dataset.error).toBe(
      'Daemon unavailable',
    );
  });

  it('ignores responses from the previous workspace', async () => {
    let resolveOld: ((value: { agents: [] }) => void) | undefined;
    apiMocks.listAgentClis
      .mockImplementationOnce(
        () =>
          new Promise<{ agents: [] }>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ agents: [detectedAgent] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));
    await act(async () => window.dispatchEvent(new Event('workspace-changed')));
    await act(async () => resolveOld?.({ agents: [] }));

    expect(container.textContent).toBe('loaded:1');
  });

  it('rechecks explicitly and ignores the superseded request', async () => {
    let resolveOld:
      | ((value: { agents: AcpAgentCliInfo[] }) => void)
      | undefined;
    apiMocks.listAgentClis
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ agents: [detectedAgent] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));
    await act(async () => container?.querySelector('button')?.click());
    await act(async () => resolveOld?.({ agents: [] }));
    expect(apiMocks.listAgentClis).toHaveBeenCalledTimes(2);
    expect(apiMocks.listAgentClis).toHaveBeenLastCalledWith({
      agentletId: 'local-device',
    });
    expect(container.textContent).toBe('loaded:1');
  });

  it('invalidates results across an observed disconnect and reconnect to the same device', async () => {
    let resolveOld:
      | ((value: { agents: AcpAgentCliInfo[] }) => void)
      | undefined;
    apiMocks.listAgentClis
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('Device offline'))
      .mockResolvedValueOnce({ agents: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<Harness enabled connectionKey="connected" />),
    );
    await act(async () =>
      root?.render(<Harness enabled connectionKey="unavailable" />),
    );
    await act(async () =>
      root?.render(<Harness enabled connectionKey="connected" />),
    );
    await act(async () => resolveOld?.({ agents: [detectedAgent] }));
    expect(apiMocks.listAgentClis).toHaveBeenCalledTimes(3);
    expect(container.textContent).toBe('loaded:0');
    expect(container.querySelector('span')?.dataset.error).toBeUndefined();
  });

  it('reloads for the edited Profile target and fences responses from the previous machine', async () => {
    let resolveOld:
      | ((value: { agents: AcpAgentCliInfo[] }) => void)
      | undefined;
    apiMocks.listAgentClis
      .mockImplementationOnce(
        () =>
          new Promise<{ agents: AcpAgentCliInfo[] }>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ agents: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<Harness enabled profileId="machine-a-profile" />),
    );
    await act(async () =>
      root?.render(<Harness enabled profileId="machine-b-profile" />),
    );
    await act(async () => resolveOld?.({ agents: [detectedAgent] }));

    expect(apiMocks.listAgentClis).toHaveBeenNthCalledWith(1, {
      profileId: 'machine-a-profile',
    });
    expect(apiMocks.listAgentClis).toHaveBeenNthCalledWith(2, {
      profileId: 'machine-b-profile',
    });
    expect(container.textContent).toBe('loaded:0');
  });

  it('clears a successful target catalogue when the next target is offline', async () => {
    apiMocks.listAgentClis
      .mockResolvedValueOnce({ agents: [detectedAgent] })
      .mockRejectedValueOnce(new Error('Target offline'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness enabled />));
    expect(container.textContent).toBe('loaded:1');
    await act(async () =>
      root?.render(<Harness enabled profileId="remote-profile" />),
    );
    expect(container.textContent).toBe('loaded:0');
    expect(apiMocks.listAgentClis).toHaveBeenLastCalledWith({
      profileId: 'remote-profile',
    });
    expect(apiMocks.toast).toHaveBeenCalledWith('Target offline', {
      tone: 'danger',
    });
  });
});
