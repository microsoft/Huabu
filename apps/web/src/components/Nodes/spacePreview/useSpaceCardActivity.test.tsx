// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useWorkspaceStore } from '@/store/workspaceStore';

import { useSpaceCardActivity } from './useSpaceCardActivity';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/api/spaceCard', () => ({ querySpaceCards: query }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
function Card({ id }: { id: string }) {
  const state = useSpaceCardActivity(id, true);
  return <span>{state?.status ?? 'loading'}</span>;
}
beforeEach(() => {
  vi.useFakeTimers();
  query.mockReset();
  query.mockResolvedValue({
    spaces: {
      a: {
        status: 'ready',
        title: 'A',
        updatedAt: 1,
        activity: [
          {
            nodeId: 'node-agent',
            threadId: 'thread',
            title: 'Task',
            status: 'running',
          },
        ],
      },
      b: { status: 'missing' },
    },
  });
  useWorkspaceStore.setState({
    workspaceId: 'one',
    isReady: true,
    isSyncing: false,
    spaceTitles: {},
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
it('deduplicates card targets, shares one refresh and pauses while hidden', async () => {
  act(() =>
    root.render(
      <>
        <Card id="a" />
        <Card id="a" />
        <Card id="b" />
      </>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toEqual(['a', 'b']);
  expect(host.textContent).toBe('readyreadymissing');
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(query).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: true,
  });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(query).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(query).toHaveBeenCalledTimes(3);
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});
it('surfaces request failures rather than treating them as no activity', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  query.mockRejectedValue(new Error('offline'));
  act(() => root.render(<Card id="a" />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(host.textContent).toBe('error');
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
it('discards a response from the previous workspace', async () => {
  let resolve!: (value: unknown) => void;
  query.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  act(() => root.render(<Card id="a" />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  act(() =>
    useWorkspaceStore.setState({
      workspaceId: 'two',
      isSyncing: true,
      spaceTitles: {},
    }),
  );
  await act(async () =>
    resolve({ spaces: { a: { status: 'ready', title: 'Old workspace' } } }),
  );
  expect(useWorkspaceStore.getState().spaceTitles).toEqual({});
  expect(host.textContent).toBe('loading');
});
