// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  CANVAS_COMMIT_INLINE_NODE_MAX_BYTES,
  canvasCommitEventSchema,
  canvasSyncEventSchema,
  mutationAckSchema,
  nodeChangeSchema,
  shouldInlineNodeUiProjection,
} from './canvas-sync.js';
import {
  deleteNodeBodySchema,
  putCanvasBodySchema,
  putNodeContentBodySchema,
} from './canvas.js';
import { preprocessNodeBodySchema } from './preprocessing.js';

import type { NodeUiProjection } from './canvas-sync.js';

function projection(content = 'hello'): NodeUiProjection {
  return {
    type: 'note',
    label: 'Note',
    content,
    rev: 'content-rev-1',
    summary: 'A short summary',
  };
}

describe('NodeChange', () => {
  it('accepts inline, invalidate, and delete changes', () => {
    expect(
      nodeChangeSchema.parse({
        kind: 'inline',
        nodeId: 'node-1',
        recordRevision: 'record-rev-1',
        projection: projection(),
      }),
    ).toMatchObject({ kind: 'inline', nodeId: 'node-1' });

    expect(
      nodeChangeSchema.parse({
        kind: 'invalidate',
        nodeId: 'node-2',
        recordRevision: 'record-rev-2',
      }),
    ).toEqual({
      kind: 'invalidate',
      nodeId: 'node-2',
      recordRevision: 'record-rev-2',
    });

    expect(
      nodeChangeSchema.parse({ kind: 'delete', nodeId: 'node-3' }),
    ).toEqual({ kind: 'delete', nodeId: 'node-3' });
  });

  it('enforces one shared 64 KiB UTF-8 JSON inline decision', () => {
    const small = projection('x'.repeat(100));
    const large = projection('😀'.repeat(CANVAS_COMMIT_INLINE_NODE_MAX_BYTES));

    expect(CANVAS_COMMIT_INLINE_NODE_MAX_BYTES).toBe(65_536);
    expect(shouldInlineNodeUiProjection(small)).toBe(true);
    expect(shouldInlineNodeUiProjection(large)).toBe(false);
    expect(
      nodeChangeSchema.safeParse({
        kind: 'inline',
        nodeId: 'node-large',
        recordRevision: 'record-rev-large',
        projection: large,
      }).success,
    ).toBe(false);
    expect(
      nodeChangeSchema.safeParse({
        kind: 'invalidate',
        nodeId: 'node-large',
        recordRevision: 'record-rev-large',
      }).success,
    ).toBe(true);
  });
});

describe('CanvasCommitEvent', () => {
  const commit = {
    commitId: 'server-commit-1',
    fromVersion: 4,
    toVersion: 5,
    structureRevision: 'sha256:structure-5',
    originator: { source: 'ui' as const, tabId: 'tab-1' },
    optimistic: true,
    recordChanged: true,
    structureDeltas: [{ type: 'REPLACE_NODE' }],
    title: 'Renamed',
    nodeOrder: ['node-2', 'node-1'],
    edgeOrder: ['edge-1'],
    nodeChanges: [
      {
        kind: 'inline' as const,
        nodeId: 'node-1',
        recordRevision: 'record-rev-1',
        projection: projection(),
      },
    ],
  };

  it('validates the complete server-authored commit payload', () => {
    expect(canvasCommitEventSchema.parse(commit)).toEqual(commit);
  });

  it('keeps the legacy update discriminant and fields wire-compatible', () => {
    const legacy = {
      type: 'update' as const,
      data: {
        fromVersion: 4,
        toVersion: 5,
        deltas: [],
        pendingEffects: {
          mutatedNodes: [],
          deletedNodeIds: [],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        },
      },
    };

    expect(canvasSyncEventSchema.parse(legacy)).toEqual(legacy);
    expect(
      canvasSyncEventSchema.parse({
        ...legacy,
        data: { ...legacy.data, commit, changesInvalidated: true },
      }).data,
    ).toHaveProperty('commit.commitId', 'server-commit-1');
    expect(
      canvasSyncEventSchema.parse({
        ...legacy,
        data: { ...legacy.data, commit, changesInvalidated: true },
      }).data,
    ).toHaveProperty('changesInvalidated', true);
  });
});

describe('MutationAck and additive mutation request fields', () => {
  it('validates the reusable acknowledgement', () => {
    expect(
      mutationAckSchema.parse({
        commitId: 'server-commit-1',
        fromVersion: 8,
        toVersion: 8,
        structureRevision: 'sha256:unchanged',
        recordChanged: false,
      }),
    ).toEqual({
      commitId: 'server-commit-1',
      fromVersion: 8,
      toVersion: 8,
      structureRevision: 'sha256:unchanged',
      recordChanged: false,
    });
  });

  it('forbids version bumps for no-op acknowledgements and events', () => {
    expect(
      mutationAckSchema.safeParse({
        commitId: 'server-commit-noop',
        fromVersion: 8,
        toVersion: 9,
        structureRevision: 'sha256:unchanged',
        recordChanged: false,
      }).success,
    ).toBe(false);
    expect(
      canvasCommitEventSchema.safeParse({
        commitId: 'server-commit-noop',
        fromVersion: 8,
        toVersion: 8,
        structureRevision: 'sha256:unchanged',
        originator: { source: 'system' },
        optimistic: false,
        recordChanged: false,
        structureDeltas: [{ type: 'unexpected' }],
        nodeChanges: [],
      }).success,
    ).toBe(false);
  });

  it('accepts originator and structural baseline without a client commit id', () => {
    const parsed = putCanvasBodySchema.parse({
      version: 7,
      state: { nodes: [], edges: [] },
      expectStructureRevision: 'sha256:baseline',
      originator: { source: 'ui', tabId: 'tab-1' },
      commitId: 'must-not-be-trusted',
    });

    expect(parsed).toEqual({
      version: 7,
      state: { nodes: [], edges: [] },
      expectStructureRevision: 'sha256:baseline',
      originator: { source: 'ui', tabId: 'tab-1' },
    });
  });

  it('accepts originator metadata on node content and preprocessing writes', () => {
    expect(
      deleteNodeBodySchema.safeParse({
        originator: { source: 'ui', tabId: 'tab-1' },
      }).success,
    ).toBe(true);
    expect(
      putNodeContentBodySchema.safeParse({
        nodeType: 'note',
        content: 'body',
        originator: { source: 'ui', tabId: 'tab-1' },
      }).success,
    ).toBe(true);
    expect(
      preprocessNodeBodySchema.safeParse({
        nodeType: 'note',
        snapshot: { content: 'body' },
        originator: { source: 'ui', tabId: 'tab-1' },
      }).success,
    ).toBe(true);
  });
});
