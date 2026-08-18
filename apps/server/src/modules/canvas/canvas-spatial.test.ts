// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Dual-field coordinate contract for the read side (`inspect_nodes` /
 * `get_canvas_outline`): every node reports `position` (parent-local,
 * the raw stored value) and `absolutePosition` (parent-chain-resolved
 * world coordinate). They coincide for root nodes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCanvasOutline, inspectNodes } from './canvas-spatial.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

interface SeedNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  parentId?: string;
  label: string;
}

function seed(canvasId: string, nodes: SeedNode[]): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        ...(n.parentId ? { parentId: n.parentId } : {}),
        style: { width: 200, height: 100 },
        measured: { width: 200, height: 100 },
        data: { label: n.label },
      })),
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function byId(result: Awaited<ReturnType<typeof inspectNodes>>): Map<
  string,
  {
    position: { x: number; y: number };
    absolutePosition: { x: number; y: number };
  }
> {
  if ('error' in result) throw new Error(result.error);
  return new Map(
    result.nodes.map((n) => [
      n.id,
      { position: n.position, absolutePosition: n.absolutePosition },
    ]),
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-spatial-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('inspect_nodes / outline — dual-field coordinates', () => {
  // Root note at (100,100); frame at (1000,500); a direct child at
  // frame-relative (50,60); a nested inner frame at frame-relative
  // (100,100) with a grandchild at inner-relative (10,20).
  const CANVAS = 'c1';
  function seedScene(): void {
    seed(CANVAS, [
      { id: 'root', type: 'note', position: { x: 100, y: 100 }, label: 'Root' },
      {
        id: 'frame',
        type: 'frame',
        position: { x: 1000, y: 500 },
        label: 'Frame',
      },
      {
        id: 'child',
        type: 'note',
        position: { x: 50, y: 60 },
        parentId: 'frame',
        label: 'Child',
      },
      {
        id: 'inner',
        type: 'frame',
        position: { x: 100, y: 100 },
        parentId: 'frame',
        label: 'Inner',
      },
      {
        id: 'grandchild',
        type: 'note',
        position: { x: 10, y: 20 },
        parentId: 'inner',
        label: 'Grandchild',
      },
    ]);
  }

  it('root node reports position == absolutePosition', async () => {
    seedScene();
    const m = byId(await inspectNodes(CANVAS, { ids: ['root'] }));
    expect(m.get('root')).toEqual({
      position: { x: 100, y: 100 },
      absolutePosition: { x: 100, y: 100 },
    });
  });

  it('framed child reports parent-local position and world absolutePosition', async () => {
    seedScene();
    const m = byId(await inspectNodes(CANVAS, { ids: ['child'] }));
    expect(m.get('child')).toEqual({
      // raw stored value = frame-relative
      position: { x: 50, y: 60 },
      // frame (1000,500) + (50,60)
      absolutePosition: { x: 1050, y: 560 },
    });
  });

  it('resolves absolutePosition through a nested frame chain', async () => {
    seedScene();
    const m = byId(await inspectNodes(CANVAS, { ids: ['grandchild'] }));
    expect(m.get('grandchild')).toEqual({
      // raw stored value = relative to inner frame
      position: { x: 10, y: 20 },
      // frame (1000,500) + inner (100,100) + (10,20)
      absolutePosition: { x: 1110, y: 620 },
    });
  });

  it('get_canvas_outline emits the same dual fields', async () => {
    seedScene();
    const outline = await buildCanvasOutline(CANVAS);
    if (!outline) throw new Error('no outline');
    const child = outline.nodes.find((n) => n.id === 'child');
    expect(child?.position).toEqual({ x: 50, y: 60 });
    expect(child?.absolutePosition).toEqual({ x: 1050, y: 560 });
  });
});
