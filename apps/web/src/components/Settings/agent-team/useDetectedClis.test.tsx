// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDetectedClis } from './useDetectedClis';

const apiMocks = vi.hoisted(() => ({
  listAgentClis: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  createAcpProfile: vi.fn(),
  flattenAcpAgentCatalogue: (response: {
    machines: Array<{ agents: Array<Record<string, unknown>> }>;
  }) =>
    response.machines.flatMap((machine) =>
      machine.agents.map((agent) => ({
        id: agent.harnessId,
        displayName: agent.displayName,
        binary: agent.binary,
        acpArgs: agent.acpArgs,
        autoApprove: agent.autoApprove ?? null,
        installHint: agent.installHint ?? '',
        installed: agent.status === 'installed',
      })),
    ),
  listAcpAgentClis: apiMocks.listAgentClis,
  updateAcpProfile: vi.fn(),
}));

function Harness({ enabled }: { enabled: boolean }) {
  const { detectedClis, loaded } = useDetectedClis(enabled);
  return (
    <span>
      {loaded ? 'loaded' : 'idle'}:{detectedClis.length}
    </span>
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  apiMocks.listAgentClis.mockReset();
});

describe('useDetectedClis', () => {
  it('defers CLI probing until the editor opens', async () => {
    apiMocks.listAgentClis.mockResolvedValueOnce({
      machines: [
        {
          agents: [
            {
              harnessId: 'copilot',
              displayName: 'Copilot',
              binary: 'copilot',
              acpArgs: ['--acp'],
              status: 'installed',
            },
          ],
        },
      ],
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
});
