// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPACE_PREVIEW_MAX_NODES } from '@huabu/shared';

import { getSpacePreviewScene } from './space-preview-scene.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

function seed(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>> = [],
): void {
  createCanvas('canvas-target', 'Target Space');
  const store = getCanvasStore('canvas-target');
  store.write({
    canvasId: 'canvas-target',
    title: 'Target Space',
    version: 3,
    state: { nodes, edges },
    createdAt: 1,
    updatedAt: 1,
  });
  for (const node of nodes) {
    const id = String(node.id);
    const data = (node.data ?? {}) as Record<string, unknown>;
    store.writeNode(id, {
      nodeId: id,
      type: String(node.type),
      label: typeof data.label === 'string' ? data.label : null,
      content: typeof data.content === 'string' ? data.content : '',
      ...(typeof data.src === 'string' ? { src: data.src } : {}),
    });
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-space-preview-'));
  setWorkspacePath(tmp);
  resetStorageCache();
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Space Preview scene projection', () => {
  it('projects absolute geometry and inert nested-preview placeholders', async () => {
    seed(
      [
        {
          id: 'node-frame',
          type: 'frame',
          position: { x: 100, y: 200 },
          style: { width: 400, height: 300 },
          data: { label: ' Frame ' },
        },
        {
          id: 'node-note',
          type: 'note',
          parentId: 'node-frame',
          position: { x: 20, y: 30 },
          measured: { width: 120, height: 80 },
          data: { label: 'Hello\n world' },
        },
        {
          id: 'node-nested',
          type: 'spacePreview',
          position: { x: 600, y: 50 },
          style: { width: 300, height: 200 },
          data: {
            label: 'Nested',
            targetCanvasId: 'canvas-other',
            content: 'must not escape',
          },
        },
      ],
      [
        {
          id: 'edge-1',
          source: 'node-note',
          target: 'node-nested',
          data: { label: '  Related   to ' },
        },
      ],
    );

    const scene = await getSpacePreviewScene('canvas-target');

    expect(scene).toMatchObject({
      canvasId: 'canvas-target',
      title: 'Target Space',
      version: 3,
      truncated: { nodes: false, edges: false },
    });
    expect(scene.nodes).toEqual([
      expect.objectContaining({
        id: 'node-frame',
        kind: 'frame',
        x: 100,
        y: 200,
        label: 'Frame',
      }),
      expect.objectContaining({
        id: 'node-note',
        kind: 'content',
        x: 120,
        y: 230,
        width: 120,
        height: 80,
        label: 'Hello world',
      }),
      expect.objectContaining({
        id: 'node-nested',
        kind: 'nested-preview',
        label: 'Nested',
      }),
    ]);
    expect(scene.edges).toEqual([
      {
        id: 'edge-1',
        source: 'node-note',
        target: 'node-nested',
        label: 'Related to',
      },
    ]);
    expect(JSON.stringify(scene)).not.toContain('must not escape');
  });

  it('reports deterministic truncation at the node budget', async () => {
    seed(
      Array.from({ length: SPACE_PREVIEW_MAX_NODES + 1 }, (_, index) => ({
        id: `node-${index}`,
        type: 'note',
        position: { x: index, y: index },
        data: { label: `Node ${index}` },
      })),
    );

    const scene = await getSpacePreviewScene('canvas-target');

    expect(scene.nodes).toHaveLength(SPACE_PREVIEW_MAX_NODES);
    expect(scene.nodes.at(-1)?.id).toBe(`node-${SPACE_PREVIEW_MAX_NODES - 1}`);
    expect(scene.truncated.nodes).toBe(true);
  });

  it('includes bounded inert Note text and Image sources', async () => {
    seed([
      {
        id: 'node-note',
        type: 'note',
        position: { x: 0, y: 0 },
        data: {
          label: 'Plan',
          content: '# Heading\n\nA **read-only** preview.',
        },
      },
      {
        id: 'node-image',
        type: 'image',
        position: { x: 500, y: 0 },
        data: { label: 'Diagram', src: 'artifact-diagram.png' },
      },
      {
        id: 'node-inline-image',
        type: 'image',
        position: { x: 900, y: 0 },
        data: { src: 'data:image/png;base64,unsafe-inline-payload' },
      },
    ]);

    const scene = await getSpacePreviewScene('canvas-target');

    expect(scene.nodes).toEqual([
      expect.objectContaining({
        id: 'node-note',
        previewText: 'Heading\n\nA read-only preview.',
      }),
      expect.objectContaining({
        id: 'node-image',
        imageSrc: 'artifact-diagram.png',
      }),
      expect.not.objectContaining({
        imageSrc: expect.anything(),
      }),
    ]);
  });

  it('rejects missing and malformed target Spaces explicitly', async () => {
    await expect(getSpacePreviewScene('canvas-missing')).rejects.toMatchObject({
      statusCode: 404,
    });

    createCanvas('canvas-broken', 'Broken');
    getCanvasStore('canvas-broken').write({
      canvasId: 'canvas-broken',
      title: 'Broken',
      version: 0,
      state: {
        nodes: [],
        edges: null as unknown as [],
      },
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(getSpacePreviewScene('canvas-broken')).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});
