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

let latestMutate:
  | ((
      action: string,
      operation: () => Promise<AgentTeamSettingsState>,
    ) => Promise<void>)
  | null = null;

function Harness() {
  const { state, loadError, mutate } = useAgentTeamSettings();
  latestMutate = mutate;
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
  latestMutate = null;
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

  it('applies the REST snapshot returned by a mutation', async () => {
    let resolveMutation: ((state: AgentTeamSettingsState) => void) | undefined;
    apiMocks.getSettings.mockResolvedValueOnce(emptyState('initial'));

    const view = renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    const mutation = new Promise<AgentTeamSettingsState>((resolve) => {
      resolveMutation = resolve;
    });
    let mutationDone: Promise<void> | undefined;
    act(() => {
      mutationDone = latestMutate?.('update', () => mutation);
    });
    await act(async () => {
      resolveMutation?.(emptyState('updated'));
      await mutationDone;
    });

    expect(view.querySelector('[data-state]')?.textContent).toBe('updated');
  });
});
