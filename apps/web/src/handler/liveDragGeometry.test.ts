// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { mergeLiveDragGeometry } from './liveDragGeometry';

import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

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
