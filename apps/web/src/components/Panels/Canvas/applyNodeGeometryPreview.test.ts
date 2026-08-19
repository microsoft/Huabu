// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { applyNodeGeometryPreview } from './applyNodeGeometryPreview';

import type { CanvasNode } from '@/components/Nodes/types';

const node = {
  id: 'frame',
  type: 'frame',
  position: { x: 10, y: 20 },
  data: {},
  style: { width: 300, height: 200 },
  measured: { width: 300, height: 200 },
} as CanvasNode;

describe('applyNodeGeometryPreview', () => {
  it('applies projected Frame position and size without mutating persisted geometry', () => {
    const previewed = applyNodeGeometryPreview(
      node,
      {
        position: { x: 30, y: 40 },
        style: { width: 180, height: 120 },
        measured: { width: 180, height: 120 },
      },
      undefined,
    );

    expect(previewed).toMatchObject({
      position: { x: 30, y: 40 },
      style: { width: 180, height: 120 },
      measured: { width: 180, height: 120 },
    });
    expect(node).toMatchObject({
      position: { x: 10, y: 20 },
      style: { width: 300, height: 200 },
    });
  });

  it('lets the active structured drop position override hierarchy position', () => {
    expect(
      applyNodeGeometryPreview(
        node,
        {
          position: { x: 30, y: 40 },
          style: { width: 180, height: 120 },
          measured: { width: 180, height: 120 },
        },
        { x: 70, y: 80 },
      ).position,
    ).toEqual({ x: 70, y: 80 });
  });

  it('preserves node identity without preview geometry', () => {
    expect(applyNodeGeometryPreview(node, undefined, undefined)).toBe(node);
  });
});
