// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getAbsolutePosition } from '@huabu/shared/canvas-engine';

import {
  applyNodeGeometryPreview,
  applyNodeGeometryPreviews,
} from './applyNodeGeometryPreview';

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

  it('builds a future tree so nested HUD geometry follows its projected parent', () => {
    const parent = {
      ...node,
      id: 'parent',
      position: { x: 100, y: 100 },
    } as CanvasNode;
    const child = {
      ...node,
      id: 'child',
      parentId: 'parent',
      selected: true,
      position: { x: 20, y: 30 },
    } as CanvasNode;
    const previewTree = applyNodeGeometryPreviews(
      [parent, child],
      new Map([
        [
          'parent',
          {
            position: { x: 40, y: 50 },
            style: parent.style,
            measured: parent.measured,
          },
        ],
      ]),
    );

    expect(getAbsolutePosition(previewTree, 'child')).toEqual({ x: 60, y: 80 });
  });
});
