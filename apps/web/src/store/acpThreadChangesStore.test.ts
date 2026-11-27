// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useSeenChangesStore } from '@/store/seenChangesStore';

import { useAcpThreadChangesStore } from './acpThreadChangesStore';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

const mocks = vi.hoisted(() => ({ get: vi.fn(), query: vi.fn() }));
vi.mock('@/api/threadChanges', () => ({
  getThreadChanges: mocks.get,
  querySpaceChanges: mocks.query,
  getSeenChanges: vi.fn(),
  markSeenChanges: vi.fn(),
  acceptThreadChange: vi.fn(),
  revertThreadChange: vi.fn(),
}));

const record = (id: string): CanvasChangeRecord => ({
  id,
  kind: 'create',
  label: id,
  nodeId: id,
  revertDeltas: [],
});

beforeEach(() => {
  mocks.get.mockReset();
  mocks.query.mockReset();
  useSeenChangesStore.getState().reset();
  useCanvasStore.setState({ canvasId: 'c1' });
  useAcpThreadChangesStore.setState({ byThread: {}, liveThreads: {} });
});

it('keeps a broadcast that arrived while an older read was in flight', async () => {
  let answer: (records: CanvasChangeRecord[]) => void = () => {};
  mocks.get.mockReturnValue(
    new Promise<CanvasChangeRecord[]>((resolve) => {
      answer = resolve;
    }),
  );
  const store = useAcpThreadChangesStore.getState();
  const reading = store.load('c1', 't1');
  store.replaceFromBroadcast('t1', [record('old'), record('new')]);
  answer([record('old')]);
  await reading;
  expect(
    useAcpThreadChangesStore.getState().byThread.t1?.map((entry) => entry.id),
  ).toEqual(['old', 'new']);
});

it('takes what the person has seen along with a Space’s records', async () => {
  mocks.query.mockResolvedValue({
    threads: { t1: [record('n1')] },
    seen: { t1: { n1: 'n1@' } },
  });
  expect(
    await useAcpThreadChangesStore.getState().loadSpace('c1', ['t1', 't2']),
  ).toBe(true);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith('c1', ['t1', 't2']);
  expect(useAcpThreadChangesStore.getState().byThread.t1).toHaveLength(1);
  expect(useSeenChangesStore.getState().seen).toEqual({ t1: { n1: 'n1@' } });
});
