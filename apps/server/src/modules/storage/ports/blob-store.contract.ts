/**
 * Backend-independent contract for {@link BlobStore}.
 *
 * Every claimed implementation runs this same suite — the validation
 * criterion in docs/proposals/multi-backend-storage.md §15. Nothing here
 * may assume a filesystem: assertions go through the port, so the suite
 * transfers verbatim to a future Azure adapter.
 *
 * Not named `*.test.ts` on purpose — it defines a suite, it isn't one.
 */

import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobNameError } from './blob.js';

import type { BlobScope, BlobScopeRef, BlobStore } from './blob.js';

export interface BlobContractHarness {
  store: BlobStore;
  ref: BlobScopeRef;
  /** Release any resources the harness allocated. */
  cleanup?: () => Promise<void> | void;
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Assert presence and narrow, so absence fails the test by name. */
function present<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`Expected ${what} to be present`);
  return value;
}

export function describeBlobStoreContract(
  name: string,
  createHarness: () => Promise<BlobContractHarness> | BlobContractHarness,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    let harness: BlobContractHarness | null = null;

    async function scope(): Promise<BlobScope> {
      harness = await createHarness();
      await harness.store.init();
      return harness.store.scope(harness.ref);
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reports its backend kind and health', async () => {
      const s = await createHarness();
      harness = s;
      await s.store.init();
      const health = await s.store.health();
      expect(health.ok).toBe(true);
      expect(health.kind).toBe(s.store.kind);
    });

    it('round-trips a Buffer body', async () => {
      const blobs = await scope();
      const body = Buffer.from('hello blob');

      const info = await blobs.put('a.txt', body);
      expect(info.name).toBe('a.txt');
      expect(info.size).toBe(body.byteLength);

      expect(await blobs.read('a.txt')).toEqual(body);
    });

    it('round-trips a stream body', async () => {
      const blobs = await scope();
      const body = Buffer.from('streamed bytes');

      const info = await blobs.put('b.bin', Readable.from([body]));
      expect(info.size).toBe(body.byteLength);
      expect(await blobs.read('b.bin')).toEqual(body);
    });

    it('overwrites an existing blob in place', async () => {
      const blobs = await scope();
      await blobs.put('c.txt', Buffer.from('first version'));
      await blobs.put('c.txt', Buffer.from('second'));

      expect(await blobs.read('c.txt')).toEqual(Buffer.from('second'));
      const info = await blobs.head('c.txt');
      expect(info?.size).toBe('second'.length);
    });

    it('reports absence as null rather than throwing', async () => {
      const blobs = await scope();
      expect(await blobs.head('missing.txt')).toBeNull();
      expect(await blobs.read('missing.txt')).toBeNull();
      expect(await blobs.open('missing.txt')).toBeNull();
      expect(await blobs.materialize('missing.txt')).toBeNull();
    });

    it('opens a full stream', async () => {
      const blobs = await scope();
      const body = Buffer.from('0123456789');
      await blobs.put('d.bin', body);

      const opened = present(await blobs.open('d.bin'), 'open("d.bin")');
      expect(opened.info.size).toBe(10);
      expect(await drain(opened.body)).toEqual(body);
    });

    it('opens an inclusive byte range while reporting full size', async () => {
      const blobs = await scope();
      await blobs.put('e.bin', Buffer.from('0123456789'));

      const opened = present(
        await blobs.open('e.bin', { start: 2, end: 5 }),
        'ranged open',
      );
      // `info.size` is the size of the blob, not of the slice.
      expect(opened.info.size).toBe(10);
      expect((await drain(opened.body)).toString()).toBe('2345');
    });

    it('bounds a range read that runs past the end', async () => {
      const blobs = await scope();
      await blobs.put('f.bin', Buffer.from('abc'));

      const opened = present(
        await blobs.open('f.bin', { start: 0, end: 65535 }),
        'over-long ranged open',
      );
      expect((await drain(opened.body)).toString()).toBe('abc');
    });

    it('lists the scope, and lists empty before any write', async () => {
      const blobs = await scope();
      expect(await blobs.list()).toEqual([]);

      await blobs.put('g1.txt', Buffer.from('one'));
      await blobs.put('g2.txt', Buffer.from('twotwo'));

      const listed = await blobs.list();
      expect(listed.map((b) => b.name).sort()).toEqual(['g1.txt', 'g2.txt']);
      expect(listed.find((b) => b.name === 'g2.txt')?.size).toBe(6);
    });

    it('checks only requested names in one batch', async () => {
      const blobs = await scope();
      await blobs.put('present.txt', Buffer.from('yes'));
      await blobs.put('unrelated.txt', Buffer.from('not requested'));

      expect(await blobs.hasMany([])).toEqual(new Set());
      expect(
        await blobs.hasMany([
          'present.txt',
          'missing.txt',
          'nested/present.txt',
          'present.txt',
        ]),
      ).toEqual(new Set(['present.txt']));
    });

    it('materializes a readable path and tolerates release', async () => {
      const blobs = await scope();
      const body = Buffer.from('materialize me');
      await blobs.put('h.txt', body);

      const lease = present(
        await blobs.materialize('h.txt'),
        'materialize("h.txt")',
      );
      expect(typeof lease.path).toBe('string');
      expect(lease.path.length).toBeGreaterThan(0);
      // `materialize` exists specifically for path-only consumers. Reading
      // the blob through the port would not prove that the lease path works.
      expect(await readFile(lease.path)).toEqual(body);
      await expect(lease.release()).resolves.toBeUndefined();
    });

    it('deleteAll empties the scope and is idempotent', async () => {
      const blobs = await scope();
      await blobs.put('i1.txt', Buffer.from('x'));
      await blobs.put('i2.txt', Buffer.from('y'));

      await blobs.deleteAll();
      expect(await blobs.list()).toEqual([]);
      expect(await blobs.head('i1.txt')).toBeNull();

      await expect(blobs.deleteAll()).resolves.toBeUndefined();
    });

    it('accepts writes again after deleteAll', async () => {
      const blobs = await scope();
      await blobs.put('j.txt', Buffer.from('before'));
      await blobs.deleteAll();

      await blobs.put('j.txt', Buffer.from('after'));
      expect(await blobs.read('j.txt')).toEqual(Buffer.from('after'));
    });

    it('normalizes a name down to its last segment', async () => {
      const blobs = await scope();
      await blobs.put('k.txt', Buffer.from('normalized'));

      // Matches the long-standing `path.basename()` contract, so callers
      // that pass a `src`-shaped value keep resolving.
      expect(await blobs.read('nested/dir/k.txt')).toEqual(
        Buffer.from('normalized'),
      );
      expect((await blobs.head('nested/k.txt'))?.name).toBe('k.txt');
    });

    it('rejects names that do not denote a file', async () => {
      const blobs = await scope();
      for (const bad of ['', '.', '..', 'dir/..']) {
        await expect(blobs.read(bad)).rejects.toBeInstanceOf(BlobNameError);
      }
    });

    it('isolates scopes from one another', async () => {
      const s = await createHarness();
      harness = s;
      await s.store.init();

      const a = s.store.scope(s.ref);
      const b = s.store.scope({ kind: 'canvas', canvasId: 'other-canvas-id' });

      await a.put('shared-name.txt', Buffer.from('from a'));
      expect(await b.head('shared-name.txt')).toBeNull();

      await b.put('shared-name.txt', Buffer.from('from b'));
      expect(await a.read('shared-name.txt')).toEqual(Buffer.from('from a'));

      await b.deleteAll();
      expect(await a.read('shared-name.txt')).toEqual(Buffer.from('from a'));
    });
  });
}
