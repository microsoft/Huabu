import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import webRoutes from './web.route.js';
import { createCanvas, getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(webRoutes, { prefix: '/web' });
  await app.ready();
  return app;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-web-route-'));
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
});
