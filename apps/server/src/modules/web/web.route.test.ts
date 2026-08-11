// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import webRoutes from './web.route.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(webRoutes, { prefix: '/web' });
  await app.ready();
  return app;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-web-route-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/web/page', () => {
  it('marks direct .mhtml artifact keys as static snapshots', async () => {
    const canvasId = 'c1';
    const nodeId = 'n1';
    createCanvas(canvasId);
    getCanvasStore(canvasId).writeNode(nodeId, {
      nodeId,
      type: 'web',
      label: 'Archived page',
      content: '',
      src: 'art_abc.mhtml',
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/web/page?canvasId=${canvasId}&nodeId=${nodeId}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        src: '/api/canvas/c1/artifact/art_abc.mhtml',
        kind: 'html',
        embeddable: true,
        snapshot: true,
      });
    } finally {
      await app.close();
    }
  });

  it('routes Interactive Views through the restricted renderer endpoint', async () => {
    const canvasId = 'c-view';
    const nodeId = 'node-view';
    createCanvas(canvasId);
    const store = getCanvasStore(canvasId);
    const current = store.read();
    if (!current) throw new Error('Canvas was not created');
    store.write({
      ...current,
      state: {
        nodes: [
          {
            id: nodeId,
            type: 'web',
            position: { x: 0, y: 0 },
            data: {
              interactiveView: {
                protocolVersion: 1,
                ownerThreadId: 'thread-owner',
                state: {
                  schema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                  value: {},
                },
                bindings: [],
                actions: [],
              },
            },
          },
        ],
        edges: [],
      },
    });
    store.writeNode(nodeId, {
      nodeId,
      type: 'web',
      label: 'Interactive View',
      content: '',
      src: 'view.html',
    });

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/web/page?canvasId=${canvasId}&nodeId=${nodeId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        src: '/api/interactive-views/c-view/node-view/renderer',
        kind: 'html',
        embeddable: true,
      });
    } finally {
      await app.close();
    }
  });
});
