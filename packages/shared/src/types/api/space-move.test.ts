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
        destination: { kind: 'existing', canvasId: 'canvas-b' },
        createSourcePreview: true,
        expectedSourceVersion: 7,
      }),
    ).toEqual({
      selectedNodeIds: ['node-a', 'node-b'],
      destination: { kind: 'existing', canvasId: 'canvas-b' },
      createSourcePreview: true,
      expectedSourceVersion: 7,
    });
  });

  it('rejects empty selections and unknown fields', () => {
    expect(
      moveSelectionBodySchema.safeParse({
        selectedNodeIds: [],
        destination: { kind: 'existing', canvasId: 'canvas-b' },
        createSourcePreview: true,
        expectedSourceVersion: 7,
      }).success,
    ).toBe(false);
    expect(
      moveSelectionBodySchema.safeParse({
        selectedNodeIds: ['node-a'],
        destination: { kind: 'new', title: '  ' },
        createSourcePreview: true,
        expectedSourceVersion: 7,
      }).success,
    ).toBe(false);
  });

  it('requires an explicit source Preview choice', () => {
    expect(
      moveSelectionBodySchema.safeParse({
        selectedNodeIds: ['node-a'],
        destination: { kind: 'existing', canvasId: 'canvas-b' },
        expectedSourceVersion: 7,
      }).success,
    ).toBe(false);
  });
});

describe('moveSelectionResponseSchema', () => {
  it('accepts the durable move outcome', () => {
    expect(
      moveSelectionResponseSchema.safeParse({
        transferId: 'transfer-a',
        destination: {
          canvasId: 'canvas-b',
          title: 'Destination',
          created: false,
        },
        sourcePreviewNodeId: 'node-preview',
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

  it('accepts an outcome without a source Preview', () => {
    expect(
      moveSelectionResponseSchema.safeParse({
        transferId: 'transfer-a',
        destination: {
          canvasId: 'canvas-b',
          title: 'Destination',
          created: false,
        },
        sourcePreviewNodeId: null,
        sourceVersion: 8,
        destinationVersion: 4,
        roots: [],
        movedNodeCount: 1,
        movedFrameCount: 0,
        preservedEdgeCount: 0,
        omittedBoundaryEdges: [],
        renamedNodes: [],
        movedConversationCount: 0,
      }).success,
    ).toBe(true);
  });
});
