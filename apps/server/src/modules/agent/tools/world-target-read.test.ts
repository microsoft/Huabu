// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { executeTool } from './executor.js';
import { refreshCanvasDirIndex } from '../../storage/canvas-dirs.js';

function writeCanvas(
  directory: string,
  canvasId: string,
  nodes: unknown[],
): void {
  const root = path.join(workspaceState.path, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title: directory,
      version: 0,
      state: { nodes, edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(
    path.join(tmpdir(), 'sediment-world-target-read-'),
  );
  writeCanvas('.world', 'canvas-world', [
    {
      id: 'node-portal',
      type: 'canvasRef',
      position: { x: 0, y: 0 },
      style: { width: 320, height: 240 },
      data: { targetCanvasId: 'canvas-a' },
    },
  ]);
  writeCanvas('Project A', 'canvas-a', [
    {
      id: 'node-source',
      type: 'note',
      position: { x: 10, y: 20 },
      style: { width: 200, height: 100 },
      data: {},
    },
  ]);
  writeCanvas('Project B', 'canvas-b', []);
  refreshCanvasDirIndex();
});

afterEach(() => {
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('World target reads', () => {
  it('exposes Portal targets and reads a referenced Space', async () => {
    const worldOutline = JSON.parse(
      (await executeTool(
        'get_space_outline',
        {},
        { canvasId: 'canvas-world' },
      )) as string,
    ) as { nodes: Array<Record<string, unknown>> };
    expect(worldOutline.nodes[0]).toMatchObject({
      id: 'node-portal',
      targetCanvasId: 'canvas-a',
    });

    const sourceOutline = JSON.parse(
      (await executeTool(
        'get_space_outline',
        { targetCanvasId: 'canvas-a' },
        { canvasId: 'canvas-world' },
      )) as string,
    ) as { nodes: Array<Record<string, unknown>> };
    expect(sourceOutline.nodes).toEqual([
      expect.objectContaining({ id: 'node-source', type: 'note' }),
    ]);
  });

  it('rejects targets outside World and targets without a Portal', async () => {
    await expect(
      executeTool(
        'get_space_outline',
        { targetCanvasId: 'canvas-b' },
        { canvasId: 'canvas-world' },
      ),
    ).rejects.toThrow('not addressed by one canonical World Portal');

    await expect(
      executeTool(
        'get_space_outline',
        { targetCanvasId: 'canvas-b' },
        { canvasId: 'canvas-a' },
      ),
    ).rejects.toThrow('available only in a World conversation');
  });

  it('surfaces malformed target topology as an error', async () => {
    writeFileSync(
      path.join(workspaceState.path, 'Project A', 'space.json'),
      '{',
      'utf8',
    );

    await expect(
      executeTool(
        'get_space_outline',
        { targetCanvasId: 'canvas-a' },
        { canvasId: 'canvas-world' },
      ),
    ).rejects.toThrow();
  });
});
