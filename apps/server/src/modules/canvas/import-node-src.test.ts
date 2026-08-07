import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importForeignNodeSources } from './import-node-src.js';
import { canvasBlobs, createCanvas, getCanvasStore } from '../storage/index.js';
import { canvasRoot } from '../storage/paths.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@sediment/shared';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sediment-import-node-src-'));
  setWorkspacePath(tmp);
  for (const canvasId of [
    'c-web-local',
    'c-web-invalid-local',
    'c-web-remote',
    'c-web-data',
    'c-web-merge-local',
    'c-web-merge-remote',
    'c-image-local',
  ]) {
    createCanvas(canvasId);
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Stage a file under the canvas's hidden `.upload/` scratch dir. */
function stageUpload(canvasId: string, name: string, body: string): string {
  const uploadDir = path.join(canvasRoot(canvasId), '.upload');
  mkdirSync(uploadDir, { recursive: true });
  const abs = path.join(uploadDir, name);
  writeFileSync(abs, body);
  return abs;
}

/** Extract the (single) node's rewritten `src` from a CREATE_NODES batch. */
function firstSrc(commands: CanvasCommand[]): string | undefined {
  const create = commands.find((c) => c.type === 'CREATE_NODES');
  if (create?.type !== 'CREATE_NODES') return undefined;
  const data = create.nodes[0]?.data as Record<string, unknown> | undefined;
  return data?.['src'] as string | undefined;
}

/** Extract the first rewritten `src` from a MERGE_NODE_DATA batch. */
function firstPatchedSrc(commands: CanvasCommand[]): string | undefined {
  const merge = commands.find((c) => c.type === 'MERGE_NODE_DATA');
  if (merge?.type !== 'MERGE_NODE_DATA') return undefined;
  const src = merge.patches[0]?.patch?.src;
  return typeof src === 'string' ? src : undefined;
}

/** Seed a Space with one existing web node for merge-path tests. */
function seedWebNode(canvasId: string, nodeId: string, src: string): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: nodeId,
          type: 'web',
          position: { x: 0, y: 0 },
          data: { label: 'Existing page', src },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe('importForeignNodeSources — web nodes', () => {
  it('relocates a locally-staged HTML upload into .artifacts/ and reclaims it', async () => {
    const canvasId = 'c-web-local';
    const store = getCanvasStore(canvasId);
    const uploadAbs = stageUpload(
      canvasId,
      'index.html',
      '<!doctype html><title>hi</title>',
    );

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: 'upload/index.html', label: 'My page' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);
    const src = firstSrc(out);

    // Rewritten to a bare artifact key…
    expect(src).toMatch(/^artifact-[^/]+\.html$/);
    // …whose file exists in the artifact store…
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten web src');
    expect(await canvasBlobs(canvasId).head(src)).not.toBeNull();
    // …and the staging upload was reclaimed (move semantics).
    expect(existsSync(uploadAbs)).toBe(false);
  });

  it('rejects a non-HTML local upload without reclaiming it', async () => {
    const canvasId = 'c-web-invalid-local';
    const store = getCanvasStore(canvasId);
    const uploadAbs = stageUpload(canvasId, 'document.pdf', 'not html');

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: 'upload/document.pdf', label: 'Wrong source' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);

    expect(firstSrc(out)).toBe('upload/document.pdf');
    expect(existsSync(uploadAbs)).toBe(true);
  });

  it('leaves a live remote URL untouched (never downloads it)', async () => {
    const canvasId = 'c-web-remote';
    const store = getCanvasStore(canvasId);
    const remote = 'https://example.com/some/page.html';

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: remote, label: 'Live site' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);
    expect(firstSrc(out)).toBe(remote);
  });

  it('leaves a data: URL untouched', async () => {
    const canvasId = 'c-web-data';
    const store = getCanvasStore(canvasId);
    const dataUrl = 'data:text/html,<h1>inline</h1>';

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'web',
            data: { src: dataUrl, label: 'Inline' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);
    expect(firstSrc(out)).toBe(dataUrl);
  });

  it('relocates a local HTML upload in MERGE_NODE_DATA', async () => {
    const canvasId = 'c-web-merge-local';
    const nodeId = 'node-web-merge-local';
    seedWebNode(canvasId, nodeId, 'https://example.com/old');
    const store = getCanvasStore(canvasId);
    const uploadAbs = stageUpload(
      canvasId,
      'replacement.html',
      '<!doctype html><title>replacement</title>',
    );
    const commands: CanvasCommand[] = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId, patch: { src: 'upload/replacement.html' } }],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);
    const src = firstPatchedSrc(out);

    expect(src).toMatch(/^artifact-[^/]+\.html$/);
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten web src');
    expect(await canvasBlobs(canvasId).head(src)).not.toBeNull();
    expect(existsSync(uploadAbs)).toBe(false);
  });

  it('leaves a remote URL untouched in MERGE_NODE_DATA', async () => {
    const canvasId = 'c-web-merge-remote';
    const nodeId = 'node-web-merge-remote';
    seedWebNode(canvasId, nodeId, 'https://example.com/old');
    const store = getCanvasStore(canvasId);
    const remote = 'https://example.com/new';
    const commands: CanvasCommand[] = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId, patch: { src: remote } }],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);

    expect(firstPatchedSrc(out)).toBe(remote);
  });
});

describe('importForeignNodeSources — media nodes (regression)', () => {
  it('still relocates a locally-staged image upload', async () => {
    const canvasId = 'c-image-local';
    const store = getCanvasStore(canvasId);
    stageUpload(canvasId, 'pic.png', 'not-a-real-png-but-bytes');

    const commands: CanvasCommand[] = [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            nodeType: 'image',
            data: { src: 'upload/pic.png' },
            position: { x: 0, y: 0 },
          },
        ],
      },
    ];

    const out = await importForeignNodeSources(store, canvasId, commands);
    const src = firstSrc(out);
    expect(src).toMatch(/^artifact-[^/]+\.png$/);
    expect(src).toBeDefined();
    if (src === undefined) throw new Error('Expected a rewritten image src');
    expect(await canvasBlobs(canvasId).head(src)).not.toBeNull();
  });
});
