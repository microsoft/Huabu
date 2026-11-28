// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useSeenChangesStore } from '@/store/seenChangesStore';
import { seenKey } from '@/utils/unseenChanges';

import { useAcpThreadChangesStore } from './acpThreadChangesStore';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

const mocks = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn() }));
vi.mock('@/api/threadChanges', () => ({
  getThreadChanges: mocks.get,
  querySpaceChanges: vi.fn(),
  acceptThreadChange: mocks.accept,
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
  mocks.accept.mockReset();
  useSeenChangesStore.setState({ seen: {} });
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

it('leaves a node seen when keeping its change fails, and forgets it once kept', async () => {
  const kept = record('n1');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  useAcpThreadChangesStore.setState({ byThread: { t1: [kept] } });
  useSeenChangesStore.getState().markSeen('t1', [seenKey(kept)]);
  // The server refuses; the record comes back with the read that follows.
  mocks.accept.mockRejectedValueOnce(new Error('offline'));
  mocks.get.mockResolvedValue([kept]);
  await useAcpThreadChangesStore.getState().accept('c1', 't1', 'n1');
  await vi.waitFor(() =>
    expect(useAcpThreadChangesStore.getState().byThread.t1).toHaveLength(1),
  );
  expect(useSeenChangesStore.getState().seen.t1).toEqual([seenKey(kept)]);
  // Kept for good, its key has nothing left to mark seen.
  mocks.accept.mockResolvedValueOnce({ removed: true });
  await useAcpThreadChangesStore.getState().accept('c1', 't1', 'n1');
  expect(useSeenChangesStore.getState().seen.t1).toBeUndefined();
  log.mockRestore();
});
