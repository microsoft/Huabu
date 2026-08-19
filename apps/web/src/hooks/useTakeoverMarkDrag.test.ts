// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { projectTakeoverDraggedNodes } from './useTakeoverMarkDrag';

import type { Node } from '@xyflow/react';

describe('projectTakeoverDraggedNodes', () => {
  it('projects the primary and selected peers from their gesture starts', () => {
    const nodes = [
      { id: 'question', position: { x: 10, y: 20 }, data: {} },
      { id: 'peer', position: { x: 50, y: 80 }, data: {} },
    ] as Node[];
    const starts = new Map([
      ['question', { x: 10, y: 20 }],
      ['peer', { x: 50, y: 80 }],
    ]);

    expect(projectTakeoverDraggedNodes(nodes, starts, 15, -5)).toMatchObject([
      { id: 'question', position: { x: 25, y: 15 } },
      { id: 'peer', position: { x: 65, y: 75 } },
    ]);
  });
});
