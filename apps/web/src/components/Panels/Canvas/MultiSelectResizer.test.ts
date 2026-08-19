// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  canSnapshotMultiSelectRoot,
  resolveMultiSelectGeometry,
  resolveMultiSelectScale,
} from './MultiSelectResizer';

describe('canSnapshotMultiSelectRoot', () => {
  it('excludes a locked selected root from resize geometry', () => {
    expect(canSnapshotMultiSelectRoot({ data: { locked: true } })).toBe(false);
    expect(canSnapshotMultiSelectRoot({ data: {} })).toBe(true);
  });
});

describe('resolveMultiSelectScale', () => {
  it('keeps free-axis scaling for selections without locked media', () => {
    expect(
      resolveMultiSelectScale({
        offX: 200,
        offY: 50,
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        uniform: false,
      }),
    ).toEqual({ scaleX: 2, scaleY: 0.5 });
  });

  it('uses one scale when the selection contains aspect-locked media', () => {
    const scale = resolveMultiSelectScale({
      offX: 200,
      offY: 50,
      diag: { x: 100, y: 100 },
      diagLen2: 20_000,
      uniform: true,
    });

    expect(scale.scaleX).toBe(scale.scaleY);
    expect(scale).toEqual({ scaleX: 1.25, scaleY: 1.25 });
  });
});

describe('resolveMultiSelectGeometry', () => {
  it('scales a selected Frame and its child in the same coordinate space', () => {
    const items = resolveMultiSelectGeometry({
      snapshot: {
        anchor: { x: 0, y: 0 },
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        nodes: [
          {
            id: 'frame',
            scaleRootId: 'frame',
            parentAbs: { x: 0, y: 0 },
            pos0Abs: { x: 100, y: 100 },
            size0: { width: 200, height: 200 },
            preserveAspectRatio: false,
          },
          {
            id: 'child',
            parentId: 'frame',
            scaleRootId: 'frame',
            parentAbs: { x: 100, y: 100 },
            pos0Abs: { x: 150, y: 160 },
            size0: { width: 80, height: 60 },
            preserveAspectRatio: false,
          },
        ],
      },
      scaleX: 0.5,
      scaleY: 0.5,
    });

    expect(items).toEqual([
      {
        nodeId: 'frame',
        position: { x: 50, y: 50 },
        size: { width: 100, height: 100 },
      },
      {
        nodeId: 'child',
        position: { x: 25, y: 30 },
        size: { width: 40, height: 30 },
      },
    ]);
  });

  it('scales nested Frames once relative to the outer scaling root', () => {
    const items = resolveMultiSelectGeometry({
      snapshot: {
        anchor: { x: 0, y: 0 },
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        nodes: [
          {
            id: 'outer',
            scaleRootId: 'outer',
            parentAbs: { x: 0, y: 0 },
            pos0Abs: { x: 100, y: 100 },
            size0: { width: 200, height: 200 },
            preserveAspectRatio: false,
          },
          {
            id: 'inner',
            parentId: 'outer',
            scaleRootId: 'outer',
            parentAbs: { x: 100, y: 100 },
            pos0Abs: { x: 140, y: 140 },
            size0: { width: 100, height: 100 },
            preserveAspectRatio: false,
          },
          {
            id: 'child',
            parentId: 'inner',
            scaleRootId: 'outer',
            parentAbs: { x: 140, y: 140 },
            pos0Abs: { x: 160, y: 160 },
            size0: { width: 20, height: 20 },
            preserveAspectRatio: false,
          },
        ],
      },
      scaleX: 0.5,
      scaleY: 0.5,
    });

    expect(items).toEqual([
      {
        nodeId: 'outer',
        position: { x: 50, y: 50 },
        size: { width: 100, height: 100 },
      },
      {
        nodeId: 'inner',
        position: { x: 20, y: 20 },
        size: { width: 50, height: 50 },
      },
      {
        nodeId: 'child',
        position: { x: 10, y: 10 },
        size: { width: 10, height: 10 },
      },
    ]);
  });
});
