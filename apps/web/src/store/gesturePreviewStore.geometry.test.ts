// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Node geometry previews.
 *
 * These previews deliberately live here rather than on `canvasStore.nodes`:
 * they are re-projected at ~60 fps while a drag/drop is being aimed, and the
 * canvas store is persisted, undoable, broadcast geometry. Keeping them
 * separate prevents a mid-drag save or history snapshot from capturing geometry
 * the user never committed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useGesturePreviewStore } from './gesturePreviewStore';

import type { NestableNode } from '@huabu/shared/canvas-engine';

const store = () => useGesturePreviewStore.getState();

beforeEach(() => {
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
});

describe('node geometry previews', () => {
  const projected = {
    id: 'frame',
    type: 'frame',
    position: { x: 20, y: 30 },
    data: {},
    style: { width: 180, height: 120 },
    measured: { width: 180, height: 120 },
  } as NestableNode;

  it('keeps state identity for an unchanged frame projection', () => {
    store().setNodeGeometryPreviews([projected]);
    const first = store();

    store().setNodeGeometryPreviews([{ ...projected }]);

    expect(store()).toBe(first);
  });

  it('clears geometry on drag teardown and canvas reset', () => {
    store().setNodeGeometryPreviews([projected]);
    store().clearNodeGeometryPreviews();
    expect(store().nodeGeometryPreviews).toBeNull();

    store().setNodeGeometryPreviews([projected]);
    store().resetCanvasScopedTransients();
    expect(store().nodeGeometryPreviews).toBeNull();
  });
});
