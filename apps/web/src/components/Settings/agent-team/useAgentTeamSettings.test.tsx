import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentTeamSettings } from './useAgentTeamSettings';

import type { AgentTeamSettingsState } from '@sediment/shared';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
}));

vi.mock('@/api/agent-team', () => ({
  getAgentTeamSettings: apiMocks.getSettings,
}));

const emptyState = (localMachine: string): AgentTeamSettingsState => ({
  machines: [],
  localMachine,
  roots: [],
  members: [],
});

function Harness() {
  const { state, loadError } = useAgentTeamSettings();
  return (
    <div>
      <span data-state>{state?.localMachine ?? 'loading'}</span>
      <span data-error>{loadError ?? ''}</span>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness />);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  apiMocks.getSettings.mockReset();
});

describe('useAgentTeamSettings', () => {
  it('loads the initial REST snapshot', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(emptyState('rest-machine'));

    const view = renderHarness();
    expect(view.querySelector('[data-state]')?.textContent).toBe('loading');
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.getSettings).toHaveBeenCalledOnce();
    expect(view.querySelector('[data-state]')?.textContent).toBe(
      'rest-machine',
    );
  });

  it('surfaces an initial REST load error', async () => {
    apiMocks.getSettings.mockRejectedValueOnce(new Error('unavailable'));

    const view = renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.querySelector('[data-error]')?.textContent).toBe('unavailable');
  });
});
