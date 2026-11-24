// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { useTurnNotices } from './useTurnNotices';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeNotification {
  static permission = 'granted';
  static all: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options: { body: string },
  ) {
    FakeNotification.all.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

let at: ReturnType<typeof useLocation> | undefined;
function Page() {
  useTurnNotices('c1');
  at = useLocation();
  return null;
}

let root: Root;
let focused = false;
const thread = (id: string, patch: object) =>
  act(async () =>
    useChatStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        [id]: { messages: [], isStreaming: false, ...patch },
      } as never,
    })),
  );
/** Run a turn of `id` to its end and let the notice be told. */
async function finish(id: string) {
  await thread(id, { isStreaming: true });
  await act(async () => vi.advanceTimersByTime(150));
  await thread(id, { completedTurnId: `${id}-done` });
  await act(async () => vi.advanceTimersByTime(1_300));
}

beforeEach(async () => {
  vi.useFakeTimers();
  FakeNotification.all = [];
  focused = false;
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  useWorkspaceStore.setState({ workspaceId: 'w1' });
  useChatStore.setState({ threadsById: {} });
  useCanvasStore.setState({
    canvasId: 'c1',
    canvasTitle: 'Space',
    isLoading: false,
    nodes: [
      {
        id: 'q1',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { type: 'question', label: 'Plan', threadId: 't1' },
      },
    ] as never,
  });
  root = createRoot(document.createElement('div'));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/elsewhere']}>
        <Page />
      </MemoryRouter>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useTurnNotices in a browser', () => {
  it('opens the Space it was made in, on its nodes, with the Workspace named', async () => {
    await finish('t1');
    expect(FakeNotification.all).toHaveLength(1);
    await act(async () => FakeNotification.all[0]?.onclick?.());
    expect(at?.pathname).toBe('/canvas/c1');
    expect(at?.state).toEqual({ focusNodeIds: ['q1'], workspaceId: 'w1' });
    expect(FakeNotification.all[0]?.closed).toBe(true);
  });

  it('withdraws its notifications when the person comes back to the page', async () => {
    await finish('t1');
    focused = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(FakeNotification.all[0]?.closed).toBe(true);
  });

  it('closes what it showed when the page leaves the Space', async () => {
    await finish('t1');
    await act(async () => root.unmount());
    expect(FakeNotification.all[0]?.closed).toBe(true);
    // The shared teardown unmounts again; give it something to unmount.
    root = createRoot(document.createElement('div'));
  });

  it('replaces a conversation’s notification, and shows none to a page in front', async () => {
    await finish('t1');
    await finish('t1');
    expect(FakeNotification.all).toHaveLength(2);
    expect(FakeNotification.all[0]?.closed).toBe(true);
    expect(FakeNotification.all[1]?.closed).toBe(false);
    focused = true;
    await finish('t1');
    expect(FakeNotification.all).toHaveLength(2);
  });
});
