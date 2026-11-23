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

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/api/threadChanges', () => ({
  querySpaceChanges: mocks.query,
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
  mocks.query.mockReset().mockResolvedValue({});
  useSeenChangesStore.setState({ seen: {} });
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
  });

  it('does not count a node that was one of several selected', async () => {
    await act(async () => root.render(<Tracker />));
    await select('n1', 'n2');
    await settle();
    await select();
    await settle();
    expect(readUnseenMarks().size).toBe(2);
  });

  it('ends a conversation’s marks when its next turn begins', async () => {
    await act(async () => root.render(<Tracker />));
    await streamT1(true);
    await settle();
    expect(readUnseenMarks().size).toBe(0);
  });

  it('keeps the marks of a turn already under way when the page opens', async () => {
    await streamT1(true);
    await act(async () => root.render(<Tracker />));
    await settle();
    expect(readUnseenMarks().size).toBe(2);
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
