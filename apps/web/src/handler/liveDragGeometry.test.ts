// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  compensateDetachedDragPosition,
  getDragPointerPosition,
  mergeLiveDragGeometry,
} from './liveDragGeometry';

import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

describe('getDragPointerPosition', () => {
  it('reads mouse and pen client coordinates, including zero', () => {
    expect(getDragPointerPosition({ clientX: 0, clientY: 20 })).toEqual({
      x: 0,
      y: 20,
    });
  });

  it('reads the changed touch during movement and after all fingers lift', () => {
    const changedTouches = [{ clientX: 40, clientY: 60 }];
    for (const touches of [changedTouches, []]) {
      expect(getDragPointerPosition({ touches, changedTouches })).toEqual({
        x: 40,
        y: 60,
      });
    }
  });

  it('falls back to an active touch when no changed touch is supplied', () => {
    expect(
      getDragPointerPosition({ touches: [{ clientX: 10, clientY: 30 }] }),
    ).toEqual({ x: 10, y: 30 });
  });

  it('preserves the geometry fallback for events without coordinates', () => {
    expect(getDragPointerPosition(undefined)).toBeUndefined();
    expect(
      getDragPointerPosition({ touches: [], changedTouches: [] }),
    ).toBeUndefined();
  });
});

describe('mergeLiveDragGeometry', () => {
  it('uses the drag event measurement for an auto-height Question node', () => {
    const stored = {
      id: 'question',
      type: 'question',
      position: { x: 10, y: 20 },
      data: {},
      style: { width: 200 },
    } as NestableNode;
    const live = {
      ...stored,
      position: { x: 80, y: 100 },
      measured: { width: 204, height: 92 },
    } as Node;

    expect(mergeLiveDragGeometry(stored, live)).toMatchObject({
      position: { x: 80, y: 100 },
      measured: { width: 204, height: 92 },
    });
  });

  it('falls back to defaults before the Question node is measured', () => {
    const stored = {
      id: 'question',
      type: 'question',
      position: { x: 10, y: 20 },
      data: {},
      style: { width: 200 },
    } as NestableNode;
    const live = { ...stored, position: { x: 80, y: 100 } } as Node;

    expect(mergeLiveDragGeometry(stored, live).measured).toEqual({
      width: 200,
      height: 80,
    });
  });
});

describe('compensateDetachedDragPosition', () => {
  it('keeps the detached world position stable when the previewed parent moves', () => {
    const liveNode = {
      id: 'dragged',
      type: 'note',
      parentId: 'frame',
      position: { x: 400, y: 400 },
      data: {},
    } as NestableNode;
    const projectedNodes = [
      {
        id: 'frame',
        type: 'frame',
        position: { x: 140, y: 140 },
        data: {},
      },
      {
        ...liveNode,
        parentId: undefined,
        position: { x: 500, y: 500 },
      },
    ] as NestableNode[];

    expect(compensateDetachedDragPosition(liveNode, projectedNodes)).toEqual({
      x: 360,
      y: 360,
    });
  });

  it('does not compensate a drag that remains in its parent', () => {
    const liveNode = {
      id: 'dragged',
      type: 'note',
      parentId: 'frame',
      position: { x: 40, y: 40 },
      data: {},
    } as NestableNode;

    expect(
      compensateDetachedDragPosition(liveNode, [
        {
          id: 'frame',
          type: 'frame',
          position: { x: 100, y: 100 },
          data: {},
        } as NestableNode,
        liveNode,
      ]),
    ).toBeNull();
  });
});
