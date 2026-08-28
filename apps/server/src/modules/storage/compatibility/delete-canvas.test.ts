// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeOnServer } from '../../canvas/canvas-executor.js';
import { DiskBlobStore } from '../backends/disk/blob-store.js';
import { refreshCanvasDirIndex } from '../backends/disk/canvas-dirs.js';
import { artifactPath, canvasJsonPath } from '../backends/disk/layout.js';
import { resetStorageCache } from '../backends/disk/legacy/canvas-store-cache.js';
import { DiskStructuredStore } from '../backends/disk/structured-store.js';
import { getCanvasStore } from '../index.js';
import {
  composeStorage,
  space,
  deleteSpace,
  setStorageForTesting,
} from '../storage.js';

import type {
  BlobInfo,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from '../ports/blob.js';
import type { Readable } from 'node:stream';

const workspaceState = vi.hoisted(() => ({ path: '', leaseCount: 0 }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
  acquireWorkspaceOperationLease: () => {
    const workspacePath = workspaceState.path;
    workspaceState.leaseCount += 1;
    let released = false;
    return Object.freeze({
      workspacePath,
      release: () => {
        if (released) return;
        released = true;
        workspaceState.leaseCount -= 1;
      },
    });
  },
}));

function writeCanvas(directory: string, canvasId: string, title: string): void {
  const root = path.join(workspaceState.path, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title,
      version: 0,
      state: { nodes: [], edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
}

/**
 * Wraps the real disk blob store and records whether the Space's structured
 * record still existed at the moment its blobs were swept.
 *
 * On Disk both end up gone either way, so the ordering that
 * docs/proposals/multi-backend-storage.md §8 cares about — blobs first,
 * while something still names them — is only observable from inside the
 * sweep.
 */
class OrderRecordingBlobStore implements BlobStore {
  readonly kind = 'disk' as const;
  readonly recordPresentAtSweep: boolean[] = [];

  private readonly inner = new DiskBlobStore();

  init(): Promise<void> {
    return this.inner.init();
  }

  health(): ReturnType<BlobStore['health']> {
    return this.inner.health();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  scope(ref: BlobScopeRef): BlobScope {
    const scope = this.inner.scope(ref);
    const seen = this.recordPresentAtSweep;
    return {
      put: (name: string, body: Readable | Buffer): Promise<BlobInfo> =>
        scope.put(name, body),
      head: (name: string): Promise<BlobInfo | null> => scope.head(name),
      open: (name: string, range?: BlobRange): Promise<BlobRead | null> =>
        scope.open(name, range),
      read: (name: string): Promise<Buffer | null> => scope.read(name),
      hasMany: (names: readonly string[]): Promise<ReadonlySet<string>> =>
        scope.hasMany(names),
      list: (): Promise<BlobInfo[]> => scope.list(),
      materialize: (name: string) => scope.materialize(name),
      deleteAll: async (): Promise<void> => {
        seen.push(existsSync(canvasJsonPath(ref.canvasId)));
        await scope.deleteAll();
      },
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControllableBlobStore implements BlobStore {
  readonly kind = 'disk' as const;
  readonly putStarted = deferred();
  readonly deleteStarted = deferred();
  readonly #putsReleased = deferred();
  readonly #deletesReleased = deferred();
  readonly #inner = new DiskBlobStore();

  blockPuts = false;
  blockDeletes = false;
  putCalls = 0;
  deleteCalls = 0;

  releasePuts(): void {
    this.#putsReleased.resolve();
  }

  releaseDeletes(): void {
    this.#deletesReleased.resolve();
  }

  init(): Promise<void> {
    return this.#inner.init();
  }

  health(): ReturnType<BlobStore['health']> {
    return this.#inner.health();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  scope(ref: BlobScopeRef): BlobScope {
    const scope = this.#inner.scope(ref);
    return {
      put: async (name: string, body: Readable | Buffer): Promise<BlobInfo> => {
        this.putCalls += 1;
        this.putStarted.resolve();
        if (this.blockPuts) await this.#putsReleased.promise;
        return scope.put(name, body);
      },
      head: (name: string): Promise<BlobInfo | null> => scope.head(name),
      open: (name: string, range?: BlobRange): Promise<BlobRead | null> =>
        scope.open(name, range),
      read: (name: string): Promise<Buffer | null> => scope.read(name),
      hasMany: (names: readonly string[]): Promise<ReadonlySet<string>> =>
        scope.hasMany(names),
      list: (): Promise<BlobInfo[]> => scope.list(),
      materialize: (name: string) => scope.materialize(name),
      deleteAll: async (): Promise<void> => {
        this.deleteCalls += 1;
        this.deleteStarted.resolve();
        if (this.blockDeletes) await this.#deletesReleased.promise;
        await scope.deleteAll();
      },
    };
  }
}

let blobs: OrderRecordingBlobStore;
let restoreStorage: () => void;

function installBlobStore(next: BlobStore): void {
  restoreStorage();
  restoreStorage = setStorageForTesting(
    composeStorage(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      new DiskStructuredStore(),
      next,
    ),
  );
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(path.join(tmpdir(), 'huabu-delete-'));
  workspaceState.leaseCount = 0;
  writeCanvas('.world', 'canvas-world', 'World');
  writeCanvas('Project A', 'canvas-a', 'Project A');
  refreshCanvasDirIndex();
  resetStorageCache();

  blobs = new OrderRecordingBlobStore();
  restoreStorage = setStorageForTesting(
    composeStorage(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      new DiskStructuredStore(),
      blobs,
    ),
  );
});

afterEach(() => {
  expect(workspaceState.leaseCount).toBe(0);
  restoreStorage();
  resetStorageCache();
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('deleteSpace composition', () => {
  it('sweeps blobs while the record that names them still exists', async () => {
    mkdirSync(path.dirname(artifactPath('canvas-a', 'art_1.png')), {
      recursive: true,
    });
    writeFileSync(artifactPath('canvas-a', 'art_1.png'), 'bytes');

    await expect(deleteSpace('canvas-a')).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });

    // Blobs first: after the structured record is gone nothing names them,
    // so a failed sweep on a remote backend would strand them permanently.
    expect(blobs.recordPresentAtSweep).toEqual([true]);
    expect(existsSync(artifactPath('canvas-a', 'art_1.png'))).toBe(false);
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
  });

  it('reports a Space that was already gone', async () => {
    await expect(deleteSpace('canvas-missing')).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses the World canvas without touching its blobs', async () => {
    mkdirSync(path.dirname(artifactPath('canvas-world', 'art_w.png')), {
      recursive: true,
    });
    writeFileSync(artifactPath('canvas-world', 'art_w.png'), 'bytes');

    await expect(deleteSpace('canvas-world')).resolves.toEqual({
      ok: false,
      reason: 'world-forbidden',
    });

    // The refusal has to come before the sweep: with blobs deleted first, a
    // guard that lived only in `destroy()` would already have cost the World
    // its artifacts by the time it threw.
    expect(blobs.recordPresentAtSweep).toEqual([]);
    expect(existsSync(artifactPath('canvas-world', 'art_w.png'))).toBe(true);
    expect(existsSync(canvasJsonPath('canvas-world'))).toBe(true);
  });

  it('fails closed on stale malformed World metadata before touching blobs', async () => {
    const structured = new DiskStructuredStore();
    await structured.spaces().worldId();
    writeFileSync(canvasJsonPath('canvas-world'), '{ malformed', 'utf8');

    await expect(deleteSpace('canvas-a')).rejects.toThrow();
    expect(blobs.recordPresentAtSweep).toEqual([]);
    expect(
      existsSync(path.join(workspaceState.path, 'Project A', 'space.json')),
    ).toBe(true);
  });

  it('still deletes an ordinary Space when the World has disappeared', async () => {
    const structured = new DiskStructuredStore();
    await structured.spaces().worldId();
    rmSync(path.dirname(canvasJsonPath('canvas-world')), {
      recursive: true,
      force: true,
    });

    // Reporting World identity is an integrity question and still raises; the
    // delete guard only asks whether *this* Space is the protected one, and a
    // namespace without a World answers no. Raising here instead would make an
    // ordinary delete fail outright because of unrelated damage elsewhere.
    await expect(structured.spaces().worldId()).rejects.toThrow(
      /no World canvas/,
    );
    await expect(deleteSpace('canvas-a')).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
  });

  it('waits for an in-flight put before sweeping and destroying the Space', async () => {
    const controlled = new ControllableBlobStore();
    controlled.blockPuts = true;
    installBlobStore(controlled);

    const putting = space('canvas-a').blobs.put(
      'in-flight.bin',
      Buffer.from('bytes'),
    );
    await controlled.putStarted.promise;

    const deleting = deleteSpace('canvas-a');
    await Promise.resolve();
    await Promise.resolve();
    expect(controlled.deleteCalls).toBe(0);
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(true);
    expect(() =>
      getCanvasStore('canvas-a').appendEvents([
        {
          ts: 1,
          payload: {
            action: 'node_selected',
            node: { id: 'n1', type: 'note', label: 'Queued delete' },
          },
        },
      ]),
    ).toThrow(/deletion is pending/);

    controlled.releasePuts();
    await putting;
    await expect(deleting).resolves.toEqual({ ok: true, reason: 'deleted' });

    expect(controlled.deleteCalls).toBe(1);
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
    expect(existsSync(artifactPath('canvas-a', 'in-flight.bin'))).toBe(false);
  });

  it('makes a put queued behind deletion recheck and reject without recreating blobs', async () => {
    const controlled = new ControllableBlobStore();
    controlled.blockDeletes = true;
    installBlobStore(controlled);

    const deleting = deleteSpace('canvas-a');
    await controlled.deleteStarted.promise;
    expect(workspaceState.leaseCount).toBe(1);
    const putting = space('canvas-a').blobs.put(
      'too-late.bin',
      Buffer.from('orphan'),
    );

    await Promise.resolve();
    expect(controlled.putCalls).toBe(0);

    controlled.releaseDeletes();
    await expect(deleting).resolves.toEqual({ ok: true, reason: 'deleted' });
    expect(workspaceState.leaseCount).toBe(0);
    await expect(putting).rejects.toThrow(/missing Space/);

    expect(controlled.putCalls).toBe(0);
    expect(existsSync(artifactPath('canvas-a', 'too-late.bin'))).toBe(false);
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
  });

  it('rejects an executor mutation of an empty Space while deletion is pending', async () => {
    const controlled = new ControllableBlobStore();
    controlled.blockDeletes = true;
    installBlobStore(controlled);

    const deleting = deleteSpace('canvas-a');
    await controlled.deleteStarted.promise;
    try {
      await expect(
        executeOnServer({
          canvasId: 'canvas-a',
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-n1',
                  nodeType: 'note',
                  position: { x: 0, y: 0 },
                  data: { label: 'Too late', content: 'orphan' },
                },
              ],
            },
          ],
          originator: { source: 'ui' },
        }),
      ).rejects.toThrow(/deletion is pending/);
      expect(existsSync(canvasJsonPath('canvas-a'))).toBe(true);
    } finally {
      controlled.releaseDeletes();
    }
    await expect(deleting).resolves.toEqual({ ok: true, reason: 'deleted' });
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
  });

  it('rejects legacy log and node writes during and after deletion', async () => {
    const controlled = new ControllableBlobStore();
    controlled.blockDeletes = true;
    installBlobStore(controlled);
    const store = getCanvasStore('canvas-a');

    const deleting = deleteSpace('canvas-a');
    await controlled.deleteStarted.promise;
    try {
      expect(() =>
        store.appendEvents([
          {
            ts: 1,
            payload: {
              action: 'node_selected',
              node: { id: 'n1', type: 'note', label: 'Too late' },
            },
          },
        ]),
      ).toThrow(/deletion is pending/);
      expect(() =>
        store.writeNode('n1', {
          nodeId: 'n1',
          type: 'note',
          label: 'Too late',
          content: 'orphan',
        }),
      ).toThrow(/deletion is pending/);
    } finally {
      controlled.releaseDeletes();
    }
    await expect(deleting).resolves.toEqual({ ok: true, reason: 'deleted' });

    expect(() =>
      store.appendEvents([
        {
          ts: 2,
          payload: {
            action: 'node_selected',
            node: { id: 'n1', type: 'note', label: 'Still too late' },
          },
        },
      ]),
    ).toThrow(/does not exist/);
    expect(
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Still too late',
        content: 'orphan',
      }),
    ).toEqual({ ok: false, reason: 'not-found' });
    expect(existsSync(path.join(workspaceState.path, 'Project A'))).toBe(false);
  });

  it('admits concurrent puts while no deletion is waiting', async () => {
    const controlled = new ControllableBlobStore();
    controlled.blockPuts = true;
    installBlobStore(controlled);

    const first = space('canvas-a').blobs.put('first.bin', Buffer.from('1'));
    const second = space('canvas-a').blobs.put('second.bin', Buffer.from('2'));

    await vi.waitFor(() => expect(controlled.putCalls).toBe(2));
    controlled.releasePuts();
    await Promise.all([first, second]);

    expect(existsSync(artifactPath('canvas-a', 'first.bin'))).toBe(true);
    expect(existsSync(artifactPath('canvas-a', 'second.bin'))).toBe(true);
  });

  it('does not serialize another Space behind a deletion', async () => {
    writeCanvas('Project B', 'canvas-b', 'Project B');
    refreshCanvasDirIndex();
    const controlled = new ControllableBlobStore();
    controlled.blockDeletes = true;
    installBlobStore(controlled);

    const deleting = deleteSpace('canvas-a');
    await controlled.deleteStarted.promise;

    await expect(
      space('canvas-b').blobs.put('independent.bin', Buffer.from('free')),
    ).resolves.toMatchObject({ name: 'independent.bin' });
    expect(existsSync(artifactPath('canvas-b', 'independent.bin'))).toBe(true);

    controlled.releaseDeletes();
    await expect(deleting).resolves.toEqual({ ok: true, reason: 'deleted' });
  });
});
