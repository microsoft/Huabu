import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentTeamSettings } from './useAgentTeamSettings';

import type { AgentTeamSettingsState } from '@sediment/shared';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  subscribe: vi.fn(),
}));
const translationMocks = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translationMocks.t,
  }),
}));

vi.mock('@/api/agent-team', () => ({
  getAgentTeamSettings: apiMocks.getSettings,
  subscribeAgentTeamSettings: apiMocks.subscribe,
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
  const { state, streamError, mutate } = useAgentTeamSettings();
  latestMutate = mutate;
  return (
    <div>
      <span data-state>{state?.localMachine ?? 'loading'}</span>
      <span data-error>{streamError ?? ''}</span>
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
  apiMocks.subscribe.mockReset();
  latestMutate = null;
});

describe('useAgentTeamSettings', () => {
  it('bootstraps with GET before subscribing and accepts SSE updates', async () => {
    let onSnapshot: ((state: AgentTeamSettingsState) => void) | undefined;
    apiMocks.getSettings.mockResolvedValueOnce(emptyState('get-machine'));
    apiMocks.subscribe.mockImplementation(
      (handler: (state: AgentTeamSettingsState) => void) => {
        onSnapshot = handler;
        return vi.fn();
      },
    );

    const view = renderHarness();
    expect(apiMocks.subscribe).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.querySelector('[data-state]')?.textContent).toBe('get-machine');
    expect(apiMocks.subscribe).toHaveBeenCalledOnce();

    act(() => onSnapshot?.(emptyState('sse-machine')));
    expect(view.querySelector('[data-state]')?.textContent).toBe('sse-machine');
  });

  it('surfaces an initial load error while still opening the stream', async () => {
    apiMocks.getSettings.mockRejectedValueOnce('unavailable');
    apiMocks.subscribe.mockReturnValue(vi.fn());

    const view = renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.querySelector('[data-error]')?.textContent).toBe('loadFailed');
    expect(apiMocks.subscribe).toHaveBeenCalledOnce();
  });

  it('does not let a mutation response overwrite a newer SSE snapshot', async () => {
    let onSnapshot: ((state: AgentTeamSettingsState) => void) | undefined;
    let resolveMutation: ((state: AgentTeamSettingsState) => void) | undefined;
    apiMocks.getSettings.mockResolvedValueOnce(emptyState('initial'));
    apiMocks.subscribe.mockImplementation(
      (handler: (state: AgentTeamSettingsState) => void) => {
        onSnapshot = handler;
        return vi.fn();
      },
    );

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
    act(() => onSnapshot?.(emptyState('newer-sse')));
    await act(async () => {
      resolveMutation?.(emptyState('older-rest'));
      await mutationDone;
    });

    expect(view.querySelector('[data-state]')?.textContent).toBe('newer-sse');
  });
});
