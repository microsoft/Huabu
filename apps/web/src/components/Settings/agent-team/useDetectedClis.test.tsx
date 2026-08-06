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
      agents: [
        {
          id: 'copilot',
          displayName: 'Copilot',
          binary: 'copilot',
          acpArgs: ['--acp'],
          installed: true,
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
