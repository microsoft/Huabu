// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * End-to-end tests for the artifact route (`/api/canvas/:canvasId/artifact/*`).
 *
 * Exercised via Fastify `inject()` against a real temp workspace and the
 * disk blob backend, so upload → serve → clone is covered through the
 * actual route wiring rather than the helper alone. This is the path that
 * previously went through `@fastify/static`'s `sendFile`, so the byte
 * range and conditional-request behaviour it used to provide is asserted
 * here too.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import artifactRoute from './artifact.route.js';
import {
  canvasBlobs,
  getStorage,
  resetStorageCache,
  setStorageForTesting,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { BlobScope, BlobStore } from '../storage/index.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(multipart);
  await app.register(artifactRoute, { prefix: '/canvas' });
  await app.ready();
  return app;
}

/** Minimal multipart body — enough for `request.file()` to parse. */
function multipartBody(
  filename: string,
  contentType: string,
  body: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----huabutestboundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-artifact-'));
  setWorkspacePath(tmp);
  resetStorageCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('artifact route', () => {
  const png = Buffer.from('0123456789');

  it('uploads and serves an artifact round-trip', async () => {
    const app = await buildApp();
    const { payload, headers } = multipartBody('shot.png', 'image/png', png);

    const upload = await app.inject({
      method: 'POST',
      url: '/canvas/c1/artifact/image',
      payload,
      headers,
    });

    expect(upload.statusCode).toBe(200);
    const { uri, mimetype } = upload.json() as {
      uri: string;
      mimetype: string;
    };
    expect(uri).toMatch(/\.png$/);
    // Preserve the main-branch upload response: the declared MIME is echoed
    // to the caller even though Disk never persisted it as blob metadata.
    expect(mimetype).toBe('image/png');

    const served = await app.inject({
      method: 'GET',
      url: `/canvas/c1/artifact/${uri}`,
    });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(png);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['accept-ranges']).toBe('bytes');

    await app.close();
  });

  it('keeps the uploaded extension over the type default', async () => {
    const app = await buildApp();
    const { payload, headers } = multipartBody('clip.webm', 'video/webm', png);

    const upload = await app.inject({
      method: 'POST',
      url: '/canvas/c1/artifact/video',
      payload,
      headers,
    });

    expect((upload.json() as { uri: string }).uri).toMatch(/\.webm$/);
    await app.close();
  });

  it('serves a byte range so media nodes can seek', async () => {
    const app = await buildApp();
    await canvasBlobs('c1').put('a.png', png);

    const res = await app.inject({
      method: 'GET',
      url: '/canvas/c1/artifact/a.png',
      headers: { range: 'bytes=2-5' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.toString()).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    await app.close();
  });

  it('answers 304 for an unchanged artifact', async () => {
    const app = await buildApp();
    await canvasBlobs('c1').put('a.png', png);

    const first = await app.inject({
      method: 'GET',
      url: '/canvas/c1/artifact/a.png',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/canvas/c1/artifact/a.png',
      headers: { 'if-none-match': first.headers['etag'] as string },
    });

    expect(res.statusCode).toBe(304);
    await app.close();
  });

  it('404s a missing artifact', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/canvas/c1/artifact/nope.png',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not disguise a blob backend failure as a 404', async () => {
    const current = getStorage();
    const failingBlobs: BlobStore = {
      kind: 'disk',
      async init() {},
      async health() {
        return { ok: false, kind: 'disk' };
      },
      async close() {},
      scope() {
        return {
          async head() {
            throw new Error('blob backend unavailable');
          },
        } as unknown as BlobScope;
      },
    };
    const restore = setStorageForTesting({ ...current, blobs: failingBlobs });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/artifact/a.png',
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
      restore();
    }
  });

  it('rejects an unknown upload type', async () => {
    const app = await buildApp();
    const { payload, headers } = multipartBody('x.bin', 'application/x', png);
    const res = await app.inject({
      method: 'POST',
      url: '/canvas/c1/artifact/hologram',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('clones an artifact into another canvas under a fresh key', async () => {
    const app = await buildApp();
    await canvasBlobs('src-canvas').put('a.png', png);

    const res = await app.inject({
      method: 'POST',
      url: '/canvas/dst-canvas/artifact/clone-from',
      payload: { srcCanvasId: 'src-canvas', srcKey: 'a.png' },
    });

    expect(res.statusCode).toBe(200);
    const { uri } = res.json() as { uri: string };
    expect(uri).not.toBe('a.png');
    expect(uri).toMatch(/\.png$/);

    // Destination owns its own copy; the source is untouched.
    expect(await canvasBlobs('dst-canvas').read(uri)).toEqual(png);
    expect(await canvasBlobs('src-canvas').read('a.png')).toEqual(png);

    await app.close();
  });

  it('404s a clone whose source is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/canvas/dst-canvas/artifact/clone-from',
      payload: { srcCanvasId: 'src-canvas', srcKey: 'gone.png' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
