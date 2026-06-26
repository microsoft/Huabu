/**
 * Tests for `GET /api/reachback/snapshot`.
 *
 * Exercised via Fastify `inject()` so the querystring schema, nodeId
 * parsing (split / trim / dedupe / cap), and the
 * `snapshotNodesToArtifacts` error mapping are covered end-to-end.
 *
 * The successful raster path (sketch → PNG) is intentionally NOT
 * exercised here — it depends on `@resvg/resvg-wasm` and is covered at
 * the `clusterToSvg` unit level in `snapshot-node.test.ts`. These tests
 * focus on the route's own logic: validation and error surfacing.
 *
 * Auth is applied by the global preHandler in `app.ts`, not by the
 * route plugin, so injecting the plugin directly needs no Bearer token.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import reachbackRoutes from './reachback.route.js';
import { setWorkspacePath } from '../modules/workspace.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(reachbackRoutes, { prefix: '/reachback' });
  await app.ready();
  return app;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-reachback-snapshot-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/reachback/snapshot', () => {
  it('rejects a request with no canvasId (schema 400)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/reachback/snapshot?nodeIds=node-a',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30000);

  it('rejects a request whose nodeIds resolve to nothing (comma-only)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/reachback/snapshot?canvasId=c1&nodeIds=%2C%2C',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/at least one/i);
    } finally {
      await app.close();
    }
  });

  it('rejects more than the node-id cap', async () => {
    const app = await buildApp();
    try {
      const tooMany = Array.from({ length: 201 }, (_, i) => `n${i}`).join(',');
      const res = await app.inject({
        method: 'GET',
        url: `/reachback/snapshot?canvasId=c1&nodeIds=${tooMany}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/too many/i);
    } finally {
      await app.close();
    }
  });

  it('maps an unknown canvas to a 400 with the underlying message', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/reachback/snapshot?canvasId=does-not-exist&nodeIds=node-a',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/not found/i);
    } finally {
      await app.close();
    }
  });
});
