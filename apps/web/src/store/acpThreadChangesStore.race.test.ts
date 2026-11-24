// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { useAcpThreadChangesStore } from './acpThreadChangesStore';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/threadChanges', () => ({
  getThreadChanges: mocks.get,
  querySpaceChanges: vi.fn(),
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
