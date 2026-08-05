import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { DiskBlobStore } from './disk-blob.js';
import { describeBlobStoreContract } from '../ports/blob-store.contract.js';

describeBlobStoreContract('DiskBlobStore', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-blob-'));
  workspaceState.path = root;
  return {
    store: new DiskBlobStore(),
    ref: { kind: 'canvas', canvasId: 'canvas-under-test' },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});

/**
 * Atomic writes land in a sibling file first, which only this adapter knows
 * about. The port can prove the blob is never half-visible; only a
 * filesystem-level check can prove the sibling is always cleaned up.
 */
describe('DiskBlobStore temp file hygiene', () => {
  const canvasId = 'canvas-under-test';
  let root = '';

  const artifactsDir = (): string => path.join(root, canvasId, '.artifacts');

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'huabu-blob-temp-'));
    workspaceState.path = root;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cleans up after both successful and failed writes', async () => {
    const scope = new DiskBlobStore().scope({ kind: 'canvas', canvasId });

    await scope.put('kept.bin', Buffer.from('fine'));
    await scope.put('streamed.bin', Readable.from([Buffer.from('also fine')]));

    async function* brokenBody(): AsyncGenerator<Buffer> {
      yield Buffer.from('partial');
      throw new Error('body exploded');
    }
    await expect(
      scope.put('never.bin', Readable.from(brokenBody())),
    ).rejects.toThrow(/body exploded/);

    // A leaked sibling would be invisible through the port — `list()` filters
    // them — but would accumulate on disk forever, since the port has no
    // per-key delete to remove it.
    expect(readdirSync(artifactsDir()).sort()).toEqual([
      'kept.bin',
      'streamed.bin',
    ]);
  });

  it('cleans up siblings from concurrent writers to one key', async () => {
    const scope = new DiskBlobStore().scope({
      kind: 'canvas',
      canvasId: 'concurrent-canvas',
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        scope.put('hot.bin', Buffer.alloc(1024 * (i + 1), String(i))),
      ),
    );

    expect(
      readdirSync(path.join(root, 'concurrent-canvas', '.artifacts')),
    ).toEqual(['hot.bin']);
  });
});
