/**
 * P2 / Plan A — `broadcastCanvasStatePut` tests.
 *
 * The autosave PUT diffs pre- vs post-write topology and publishes the
 * structural deltas on the sync channel so *other* tabs learn about a
 * user hand-edit. These tests exercise that diff+publish in isolation:
 * geometry moves broadcast one `REPLACE_NODE`, deletes surface
 * `deletedNodeIds`, no-op writes publish nothing, and the originating
 * tab's `clientId` is echoed as `originatorClientId` for self-echo
 * filtering.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { broadcastCanvasStatePut } from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasSyncEvent } from '@sediment/shared';
import type { CanvasNode } from '@sediment/shared/canvas-engine';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-planA-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function note(id: string, x: number, y: number): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x, y },
    data: { label: id },
  } as unknown as CanvasNode;
}

/** Seed a canvas at version 1 with the given nodes. */
function seed(canvasId: string, nodes: CanvasNode[]): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: { nodes, edges: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Collect every sync event published for `canvasId` during `fn`. */
function captureEvents(canvasId: string, fn: () => void): CanvasSyncEvent[] {
  const events: CanvasSyncEvent[] = [];
  const unsubscribe = subscribeCanvasUpdates(canvasId, (e) => events.push(e));
  try {
    fn();
  } finally {
    unsubscribe();
  }
  return events;
}

describe('broadcastCanvasStatePut — P2 Plan A', () => {
  it('broadcasts a REPLACE_NODE for a geometry move, echoing clientId', () => {
    seed('c1', [note('n1', 0, 0)]);

    const events = captureEvents('c1', () => {
      broadcastCanvasStatePut({
        canvasId: 'c1',
        fromVersion: 1,
        toVersion: 2,
        prevNodes: [note('n1', 0, 0)],
        prevEdges: [],
        nextNodes: [note('n1', 100, 200)],
        nextEdges: [],
        clientId: 'tab-A',
      });
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe('update');
    if (event.type !== 'update') throw new Error('expected update');
    expect(event.data.fromVersion).toBe(1);
    expect(event.data.toVersion).toBe(2);
    expect(event.data.originatorClientId).toBe('tab-A');
    expect(event.data.deltas).toHaveLength(1);
    const [delta] = event.data.deltas as Array<{ type: string }>;
    expect(delta.type).toBe('REPLACE_NODE');
    // A plain geometry move must not schedule preprocessing / fit.
    expect(event.data.pendingEffects.mutatedNodes).toHaveLength(0);
    expect(event.data.pendingEffects.contentEditedNodeIds).toHaveLength(0);
  });

  it('publishes nothing when topology is unchanged (no-op write)', () => {
    seed('c1', [note('n1', 0, 0)]);

    const events = captureEvents('c1', () => {
      const deltas = broadcastCanvasStatePut({
        canvasId: 'c1',
        fromVersion: 1,
        toVersion: 2,
        prevNodes: [note('n1', 0, 0)],
        prevEdges: [],
        nextNodes: [note('n1', 0, 0)],
        nextEdges: [],
        clientId: 'tab-A',
      });
      expect(deltas).toHaveLength(0);
    });

    expect(events).toHaveLength(0);
  });

  it('surfaces a removed node via deletedNodeIds', () => {
    seed('c1', [note('n1', 0, 0), note('n2', 10, 10)]);

    const events = captureEvents('c1', () => {
      broadcastCanvasStatePut({
        canvasId: 'c1',
        fromVersion: 1,
        toVersion: 2,
        prevNodes: [note('n1', 0, 0), note('n2', 10, 10)],
        prevEdges: [],
        nextNodes: [note('n1', 0, 0)],
        nextEdges: [],
        clientId: 'tab-A',
      });
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event.type !== 'update') throw new Error('expected update');
    expect(event.data.pendingEffects.deletedNodeIds).toEqual(['n2']);
  });

  it('omits originatorClientId when no clientId is supplied', () => {
    seed('c1', [note('n1', 0, 0)]);

    const events = captureEvents('c1', () => {
      broadcastCanvasStatePut({
        canvasId: 'c1',
        fromVersion: 1,
        toVersion: 2,
        prevNodes: [note('n1', 0, 0)],
        prevEdges: [],
        nextNodes: [note('n1', 5, 5)],
        nextEdges: [],
      });
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event.type !== 'update') throw new Error('expected update');
    expect(event.data.originatorClientId).toBeUndefined();
  });
});
