// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { useSeenChangesStore } from '@/store/seenChangesStore';

import { readUnseenMarks, useTrackUnseenChanges } from './useUnseenChanges';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  read: vi.fn(),
  mark: vi.fn(),
}));
vi.mock('@/api/threadChanges', () => ({
  querySpaceChanges: mocks.query,
  getSeenChanges: mocks.read,
  markSeenChanges: mocks.mark,
  getThreadChanges: vi.fn(),
  acceptThreadChange: vi.fn(),
  revertThreadChange: vi.fn(),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, nodeId: string): CanvasChangeRecord => ({
  id,
  kind: 'create',
  label: `Created: ${nodeId}`,
  nodeId,
  revertDeltas: [],
  appliedFingerprint: 'f1',
  fingerprintKeys: ['content'],
});

const node = (id: string, selected = false, data: object = { type: 'note' }) =>
  ({ id, type: 'note', position: { x: 0, y: 0 }, selected, data }) as never;

function Tracker() {
  useTrackUnseenChanges('c1');
  return null;
}

let root: Root;
/** Let the tracker's throttled read of the stores run. */
const settle = () => act(async () => vi.advanceTimersByTime(200));
const select = (...ids: string[]) =>
  act(async () =>
    useCanvasStore.setState({
      nodes: [node('n1', ids.includes('n1')), node('n2', ids.includes('n2'))],
    }),
  );
const streamT1 = (isStreaming: boolean) =>
  act(async () =>
    useChatStore.setState({
      threadsById: { t1: { isStreaming } } as never,
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  mocks.query.mockReset().mockResolvedValue({ threads: {}, seen: {} });
  mocks.read.mockReset().mockResolvedValue({});
  // The server answers a mark with everything seen; here, what was sent.
  mocks.mark
    .mockReset()
    .mockImplementation(
      async (
        _canvasId: string,
        cells: { threadId: string; nodeId: string; key: string }[],
      ) =>
        Object.fromEntries(
          cells.map(({ threadId, nodeId, key }) => [
            threadId,
            { [nodeId]: key },
          ]),
        ),
    );
  useSeenChangesStore.getState().reset();
  useChatStore.setState({ threadsById: {} });
  useCanvasStore.setState({
    canvasId: 'c1',
    isLoading: false,
    nodes: [node('n1'), node('n2')],
  });
  useAcpThreadChangesStore.setState({
    byThread: { t1: [record('c1', 'n1'), record('c2', 'n2')] },
    liveThreads: {},
  });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('useTrackUnseenChanges', () => {
  it('counts a node as seen when the person leaves it, not when they arrive', async () => {
    await act(async () => root.render(<Tracker />));
    await select('n1');
    await settle();
    expect([...readUnseenMarks().keys()]).toEqual(['n1', 'n2']);
    await select();
    await settle();
    expect([...readUnseenMarks().keys()]).toEqual(['n2']);
    // Recorded on the server, so the person's other devices follow.
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith('c1', [
      { threadId: 't1', nodeId: 'n1', key: 'c1@f1' },
    ]);
  });

  it('does not count a node that was one of several selected', async () => {
    await act(async () => root.render(<Tracker />));
    await select('n1', 'n2');
    await settle();
    await select();
    await settle();
    expect(readUnseenMarks().size).toBe(2);
  });

  it('keeps a conversation’s marks when it goes on into another turn', async () => {
    await act(async () => root.render(<Tracker />));
    await streamT1(true);
    await settle();
    await streamT1(false);
    await settle();
    expect(readUnseenMarks().size).toBe(2);
  });

  it('asks again, after a wait, for changes it could not read', async () => {
    mocks.query.mockReset().mockRejectedValueOnce(new Error('offline'));
    mocks.query.mockResolvedValue({
      threads: { t9: [record('c9', 'n1')] },
      seen: {},
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAcpThreadChangesStore.setState({ byThread: {} });
    useCanvasStore.setState({
      nodes: [node('q1', false, { type: 'question', threadId: 't9' })],
    });
    await act(async () => root.render(<Tracker />));
    await settle();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(readUnseenMarks().size).toBe(0);
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect([...readUnseenMarks().keys()]).toEqual(['n1']);
    log.mockRestore();
  });

  it('asks again for every load that failed during one wait', async () => {
    mocks.query
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ threads: {}, seen: {} });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const question = (id: string, threadId: string) =>
      node(id, false, { type: 'question', threadId });
    useCanvasStore.setState({ nodes: [question('q1', 't8')] });
    await act(async () => root.render(<Tracker />));
    await settle();
    // A second conversation appears, and its load fails too, while the
    // first failure's wait is still running.
    await act(async () =>
      useCanvasStore.setState({
        nodes: [question('q1', 't8'), question('q2', 't9')],
      }),
    );
    await settle();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(mocks.query).toHaveBeenLastCalledWith('c1', ['t8', 't9']);
    log.mockRestore();
  });

  it('follows what the person saw on another device', async () => {
    mocks.read.mockResolvedValue({ t1: { n1: 'c1@f1' } });
    await act(async () => root.render(<Tracker />));
    await settle();
    // Read when the Space opened: n1 was seen elsewhere.
    expect([...readUnseenMarks().keys()]).toEqual(['n2']);
    // And again when the server says the record changed.
    mocks.read.mockResolvedValue({ t1: { n1: 'c1@f1', n2: 'c2@f1' } });
    await act(async () => useSeenChangesStore.getState().refresh('c1'));
    expect(readUnseenMarks().size).toBe(0);
  });

  it('asks once for the changes of the Space’s conversations', async () => {
    useCanvasStore.setState({
      nodes: [node('q1', false, { type: 'question', threadId: 't9' })],
    });
    await act(async () => root.render(<Tracker />));
    await select();
    await settle();
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith('c1', ['t9']);
  });
});
