// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Readable } from 'node:stream';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { resolveRange, sendBlob } from './send-blob.js';

import type { BlobInfo, BlobScope } from '../storage/index.js';

/**
 * In-memory {@link BlobScope}. Exercises `sendBlob` against the port
 * rather than a directory, which is the point of the exercise — the same
 * assertions must hold for a backend that has no filesystem.
 */
function fakeScope(blobs: Record<string, Buffer>): BlobScope {
  const info = (name: string, body: Buffer): BlobInfo => ({
    name,
    size: body.byteLength,
    updatedAt: 1_700_000_000_000,
  });
  return {
    async put() {
      throw new Error('not used');
    },
    async head(name) {
      const body = blobs[name];
      return body ? info(name, body) : null;
    },
    async open(name, range) {
      const body = blobs[name];
      if (!body) return null;
      const sliced =
        range?.start !== undefined || range?.end !== undefined
          ? body.subarray(range.start ?? 0, (range.end ?? body.length - 1) + 1)
          : body;
      return { info: info(name, body), body: Readable.from([sliced]) };
    },
    async read(name) {
      return blobs[name] ?? null;
    },
    async hasMany(names) {
      return new Set(names.filter((name) => blobs[name] !== undefined));
    },
    async list() {
      return Object.entries(blobs).map(([name, body]) => info(name, body));
    },
    async materialize() {
      return null;
    },
    async deleteAll() {},
  };
}

async function serve(
  blobs: Record<string, Buffer>,
  name: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET',
) {
  return serveScope(fakeScope(blobs), name, headers, method);
}

async function serveScope(
  scope: BlobScope,
  name: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET',
) {
  const app = Fastify();
  app.get('/blob', async (request, reply) => {
    const ok = await sendBlob(request, reply, scope, name);
    if (!ok) return reply.code(404).send({ message: 'Artifact not found' });
    return reply;
  });
  const response = await app.inject({ method, url: '/blob', headers });
  await app.close();
  return response;
}

describe('resolveRange', () => {
  it('returns null when there is no usable range', () => {
    expect(resolveRange(undefined, 100)).toBeNull();
    expect(resolveRange('bytes=', 100)).toBeNull();
    // Multi-range and non-byte units are not supported; serving the whole
    // blob is a valid response to a Range we do not understand.
    expect(resolveRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(resolveRange('items=0-1', 100)).toBeNull();
  });

  it('resolves an explicit range', () => {
    expect(resolveRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });

  it('clamps an open-ended and an over-long range to the last byte', () => {
    expect(resolveRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(resolveRange('bytes=0-9999', 100)).toEqual({ start: 0, end: 99 });
  });

  it('resolves a suffix range', () => {
    expect(resolveRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    // Suffix longer than the blob yields the whole blob, not a negative start.
    expect(resolveRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('reports unsatisfiable ranges', () => {
    expect(resolveRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(resolveRange('bytes=50-20', 100)).toBe('unsatisfiable');
    expect(resolveRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('sendBlob', () => {
  const body = Buffer.from('0123456789');

  it('serves the whole blob with caching validators', async () => {
    const res = await serve({ 'a.png': body }, 'a.png');

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(body);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('public, max-age=0');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['last-modified']).toBeDefined();
  });

  it('derives content type from the blob name', async () => {
    const res = await serve({ 'doc.pdf': body }, 'doc.pdf');
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('falls back to octet-stream for an unknown extension', async () => {
    const res = await serve({ 'thing.xyz': body }, 'thing.xyz');
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('adds a UTF-8 charset to text content', async () => {
    const res = await serve({ 'note.txt': body }, 'note.txt');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('reports a missing blob to the caller', async () => {
    const res = await serve({}, 'gone.png');
    expect(res.statusCode).toBe(404);
  });

  it('serves a byte range as 206 with Content-Range', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      range: 'bytes=2-5',
    });

    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.toString()).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
  });

  it('honours a fresh If-Range validator', async () => {
    const first = await serve({ 'a.png': body }, 'a.png');
    const res = await serve({ 'a.png': body }, 'a.png', {
      range: 'bytes=2-5',
      'if-range': first.headers['etag'] as string,
    });

    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.toString()).toBe('2345');
  });

  it('ignores Range when If-Range is stale', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      range: 'bytes=2-5',
      'if-range': 'W/"stale-validator"',
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(body);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('rejects an unsatisfiable range with 416', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      range: 'bytes=50-60',
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('answers 304 for a matching If-None-Match', async () => {
    const first = await serve({ 'a.png': body }, 'a.png');
    const etag = first.headers['etag'] as string;

    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-none-match': etag,
    });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
  });

  it('answers 200 when If-None-Match does not match', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-none-match': 'W/"deadbeef-1"',
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers 412 when If-Match does not match', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-match': 'W/"stale-validator"',
    });
    expect(res.statusCode).toBe(412);
  });

  it('answers 412 when the blob changed after If-Unmodified-Since', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-unmodified-since': new Date(1_600_000_000_000).toUTCString(),
    });
    expect(res.statusCode).toBe(412);
  });

  it('answers 304 when the blob is older than If-Modified-Since', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-modified-since': new Date(1_700_000_500_000).toUTCString(),
    });
    expect(res.statusCode).toBe(304);
  });

  it('answers 200 when the blob is newer than If-Modified-Since', async () => {
    const res = await serve({ 'a.png': body }, 'a.png', {
      'if-modified-since': new Date(1_600_000_000_000).toUTCString(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers HEAD with representation headers and no body read', async () => {
    const scope = fakeScope({ 'a.png': body });
    scope.open = vi.fn(() => {
      throw new Error('HEAD must not open the body');
    });

    const res = await serveScope(scope, 'a.png', {}, 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers['content-length']).toBe('10');
    expect(scope.open).not.toHaveBeenCalled();
  });

  it('propagates storage failures as server errors', async () => {
    const scope = fakeScope({});
    scope.head = vi.fn(() => Promise.reject(new Error('backend unavailable')));

    const res = await serveScope(scope, 'a.png');
    expect(res.statusCode).toBe(500);
  });
});
