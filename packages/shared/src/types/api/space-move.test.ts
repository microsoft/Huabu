// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  moveSelectionBodySchema,
  moveSelectionResponseSchema,
} from './space-move.js';

describe('moveSelectionBodySchema', () => {
  it('accepts a bounded move request', () => {
    expect(
      moveSelectionBodySchema.parse({
        selectedNodeIds: ['node-a', 'node-b'],
        destinationCanvasId: 'canvas-b',
        expectedSourceVersion: 7,
      }),
    ).toEqual({
      selectedNodeIds: ['node-a', 'node-b'],
      destinationCanvasId: 'canvas-b',
      expectedSourceVersion: 7,
    });
  });

  it('rejects empty selections and unknown fields', () => {
    expect(
      moveSelectionBodySchema.safeParse({
        selectedNodeIds: [],
        destinationCanvasId: 'canvas-b',
        expectedSourceVersion: 7,
      }).success,
    ).toBe(false);
    expect(
      moveSelectionBodySchema.safeParse({
        selectedNodeIds: ['node-a'],
        destinationCanvasId: 'canvas-b',
        expectedSourceVersion: 7,
        createDestination: true,
      }).success,
    ).toBe(false);
  });
});

describe('moveSelectionResponseSchema', () => {
  it('accepts the durable move outcome', () => {
    expect(
      moveSelectionResponseSchema.safeParse({
        transferId: 'transfer-a',
        destination: { canvasId: 'canvas-b', title: 'Destination' },
        sourceVersion: 8,
        destinationVersion: 4,
        roots: [
          {
            sourceNodeId: 'node-a',
            destinationNodeId: 'node-z',
            label: 'Moved',
          },
        ],
        movedNodeCount: 1,
        movedFrameCount: 0,
        preservedEdgeCount: 0,
        omittedBoundaryEdges: [],
        renamedNodes: [],
        movedConversationCount: 1,
      }).success,
    ).toBe(true);
  });
});
