// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { getCanvasAccess, putCanvas } from '@/api/canvas';

import useCanvasStore, {
  selectCanManageCanvas,
  selectCanWriteCanvas,
} from './canvasStore';
import { useIdentityStore } from './identityStore';

import type { CanvasAccess } from '@huabu/shared';

vi.mock('@/api/canvas', async (importActual) => ({
  ...(await importActual()),
  getCanvasAccess: vi.fn(),
  putCanvas: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getCanvasAccess).mockReset();
  vi.mocked(putCanvas).mockReset();
  useIdentityStore.setState({
    identity: {
      provider: 'bubble',
      principal: { principalId: 'a', kind: 'user' },
      member: true,
      owner: false,
    },
  });
  useCanvasStore.setState({
    canvasId: 'space',
    canvasAccess: null,
    nodes: [
      {
        id: 'note',
        type: 'note',
        position: { x: 1, y: 2 },
        data: { content: 'Unsaved draft' },
      },
    ],
    canvasTitle: 'Original',
    version: 7,
    pendingSave: true,
  });
});
afterEach(() => {
  useIdentityStore.setState({ identity: null });
  useCanvasStore.setState({
    canvasAccess: null,
    canvasId: '',
    nodes: [],
    pendingSave: false,
  });
});

it('unknown Bubble access is read-only and permissions are tied to the exact Space', () => {
  expect(selectCanWriteCanvas(useCanvasStore.getState())).toBe(false);
  expect(selectCanManageCanvas(useCanvasStore.getState())).toBe(false);
  useCanvasStore.setState({
    canvasAccess: { canvasId: 'previous', write: true, manage: true },
  });
  expect(selectCanWriteCanvas(useCanvasStore.getState())).toBe(false);
});

it('refreshes grant changes without replacing unsaved content, pending saves, or version', async () => {
  const before = useCanvasStore.getState();
  vi.mocked(getCanvasAccess).mockResolvedValueOnce({
    write: true,
    manage: false,
  });
  await useCanvasStore.getState().refreshCanvasAccess();
  expect(selectCanWriteCanvas(useCanvasStore.getState())).toBe(true);
  expect(selectCanManageCanvas(useCanvasStore.getState())).toBe(false);
  vi.mocked(getCanvasAccess).mockResolvedValueOnce({
    write: false,
    manage: false,
  });
  await useCanvasStore.getState().refreshCanvasAccess();
  expect(useCanvasStore.getState()).toMatchObject({
    nodes: before.nodes,
    canvasTitle: 'Original',
    version: 7,
    pendingSave: true,
    canvasAccess: { canvasId: 'space', write: false, manage: false },
  });
  expect(useCanvasStore.getState().nodes).toBe(before.nodes);
});

it.each(['Space', 'account'] as const)(
  'ignores a permission response after the %s changes',
  async (change) => {
    let resolve!: (access: CanvasAccess) => void;
    vi.mocked(getCanvasAccess).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = useCanvasStore.getState().refreshCanvasAccess();
    expect(useCanvasStore.getState().refreshCanvasAccess()).toBe(first);
    if (change === 'Space') useCanvasStore.setState({ canvasId: 'different' });
    else {
      const identity = useIdentityStore.getState().identity;
      if (!identity) throw new Error('Expected initial identity');
      useIdentityStore.setState({
        identity: {
          ...identity,
          principal: { principalId: 'b', kind: 'user' },
        },
      });
    }
    resolve({ write: true, manage: true });
    await first;
    expect(useCanvasStore.getState().canvasAccess).toBeNull();
  },
);

it('fails closed on permission-check failure and can recover after readmission', async () => {
  useCanvasStore.setState({
    canvasAccess: { canvasId: 'space', write: true, manage: true },
  });
  vi.mocked(getCanvasAccess).mockRejectedValueOnce(new Error('unreachable'));
  await useCanvasStore.getState().refreshCanvasAccess();
  expect(selectCanWriteCanvas(useCanvasStore.getState())).toBe(false);
  vi.mocked(getCanvasAccess).mockResolvedValueOnce({
    write: true,
    manage: true,
  });
  await useCanvasStore.getState().refreshCanvasAccess();
  expect(selectCanManageCanvas(useCanvasStore.getState())).toBe(true);
});

it('a 403 during rename reverts the optimistic title and settles a pending re-save without leaking rejection', async () => {
  useCanvasStore.setState({
    canvasAccess: { canvasId: 'space', write: true, manage: true },
  });
  vi.mocked(getCanvasAccess).mockResolvedValue({ write: true, manage: false });
  vi.mocked(putCanvas).mockRejectedValue(
    new ApiError(
      403,
      { code: 'SPACE_ACCESS_REQUIRED', message: 'manage required' },
      'denied',
    ),
  );
  await expect(
    useCanvasStore.getState().tryRename('canvas', 'space', 'Forbidden'),
  ).resolves.toBe(false);
  await vi.waitFor(() =>
    expect(useCanvasStore.getState().isSaving).toBe(false),
  );
  expect(useCanvasStore.getState().canvasTitle).toBe('Original');
  expect(putCanvas).toHaveBeenCalledTimes(2);
});
