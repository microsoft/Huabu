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
}: {
  enabled: boolean;
  profileId?: string;
}) {
  const { detectedClis, loaded } = useDetectedClis(enabled, profileId);
  return (
    <span>
      {loaded ? 'loaded' : 'idle'}:{detectedClis.length}
    </span>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const detectedAgent: AcpAgentCliInfo = {
  id: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  acpArgs: ['--acp'],
  autoApprove: null,
  installed: true,
  installHint: 'Install Copilot',
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

    expect(apiMocks.listAgentClis).toHaveBeenNthCalledWith(
      1,
      'machine-a-profile',
    );
    expect(apiMocks.listAgentClis).toHaveBeenNthCalledWith(
      2,
      'machine-b-profile',
    );
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
    expect(apiMocks.listAgentClis).toHaveBeenLastCalledWith('remote-profile');
    expect(apiMocks.toast).toHaveBeenCalledWith('Target offline', {
      tone: 'danger',
    });
  });
});
