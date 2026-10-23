// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useInitialCanvasViewport } from './useInitialCanvasViewport';

import type { CanvasViewport } from '@huabu/shared';
import type { ReactFlowInstance } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  viewport: null as CanvasViewport | null,
  nodes: [{ id: 'node-root' }],
  fit: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: () => mocks },
}));
vi.mock('@/utils/canvasViewport', () => ({
  fitNodesOnCanvas: mocks.fit,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useInitialCanvasViewport>;
const instance = {} as ReactFlowInstance;
function Probe({ readiness }: { readiness: 'ready' | 'pending' | 'error' }) {
  result = useInitialCanvasViewport(readiness);
  return null;
}
async function render(readiness: 'ready' | 'pending' | 'error') {
  await act(async () => root.render(<Probe readiness={readiness} />));
}
beforeEach(() => {
  mocks.viewport = null;
  mocks.nodes = [{ id: 'node-root' }];
  mocks.fit.mockReset().mockResolvedValue(true);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

it('defers the first fit until metadata is ready, without refitting on refresh', async () => {
  await render('pending');
  await act(async () => result.fitInitialViewport(instance));
  expect(result.isPending).toBe(true);
  expect(mocks.fit).not.toHaveBeenCalled();
  await render('ready');
  expect(mocks.fit).toHaveBeenCalledExactlyOnceWith(instance, ['node-root']);
  expect(result.isPending).toBe(false);
  await render('pending');
  await render('ready');
  expect(mocks.fit).toHaveBeenCalledTimes(1);
});

it('keeps saved viewports even while metadata is pending', async () => {
  mocks.viewport = { x: 30, y: 40, zoom: 0.5 };
  await render('pending');
  await act(async () => result.fitInitialViewport(instance));
  expect(result.defaultViewport).toEqual(mocks.viewport);
  expect(result.isPending).toBe(false);
  await render('ready');
  expect(mocks.fit).not.toHaveBeenCalled();
});

it('does not keep a loading overlay on metadata error and fits after retry', async () => {
  await render('pending');
  await act(async () => result.fitInitialViewport(instance));
  await render('error');
  expect(result.isPending).toBe(false);
  expect(mocks.fit).not.toHaveBeenCalled();
  await render('pending');
  expect(result.isPending).toBe(true);
  await render('ready');
  expect(mocks.fit).toHaveBeenCalledTimes(1);
  expect(result.isPending).toBe(false);
});

it('does not wait or fit for an empty Canvas', async () => {
  mocks.nodes = [];
  await render('pending');
  await act(async () => result.fitInitialViewport(instance));
  expect(result.isPending).toBe(false);
  await render('ready');
  expect(mocks.fit).not.toHaveBeenCalled();
});

it('logs fit failures and releases the loading overlay', async () => {
  const error = new Error('Viewport failed');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.fit.mockRejectedValueOnce(error);
  await render('ready');
  await act(async () => result.fitInitialViewport(instance));
  expect(result.isPending).toBe(false);
  expect(log).toHaveBeenCalledWith(
    'Failed to fit initial Canvas viewport:',
    error,
  );
});
