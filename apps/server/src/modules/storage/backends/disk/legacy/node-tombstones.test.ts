// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceTombstonesDir } from '../../../../workspace/disk/paths.js';

describe('durable node tombstones', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'huabu-tombstones-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it('survives a module reload and is removed when cleared', async () => {
    const root = workspace();
    const first = await import('./node-tombstones.js');
    first.markNodeDeleted(root, 'canvas-a', 'node-a');

    const directory = workspaceTombstonesDir(root);
    expect(readdirSync(directory)).toHaveLength(1);

    vi.resetModules();
    const restarted = await import('./node-tombstones.js');
    expect(restarted.isNodeTombstoned(root, 'canvas-a', 'node-a')).toBe(true);

    restarted.clearNodeTombstone(root, 'canvas-a', 'node-a');
    expect(restarted.isNodeTombstoned(root, 'canvas-a', 'node-a')).toBe(false);
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it('lazily expires a durable tombstone after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
    const root = workspace();
    const first = await import('./node-tombstones.js');
    first.markNodeDeleted(root, 'canvas-a', 'node-a');
    const directory = workspaceTombstonesDir(root);
    const [filename] = readdirSync(directory);
    if (!filename) throw new Error('durable tombstone fixture missing');
    const file = path.join(directory, filename);
    expect(existsSync(file)).toBe(true);

    vi.resetModules();
    vi.setSystemTime(new Date(Date.now() + first.NODE_TOMBSTONE_TTL_MS + 1));
    const restarted = await import('./node-tombstones.js');
    expect(restarted.isNodeTombstoned(root, 'canvas-a', 'node-a')).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('schedules expiry when a live scope is first loaded from disk', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-10T00:00:00.000Z');
    vi.setSystemTime(now);
    const root = workspace();
    const first = await import('./node-tombstones.js');
    first.markNodeDeleted(root, 'canvas-a', 'node-a');
    const directory = workspaceTombstonesDir(root);
    const [filename] = readdirSync(directory);
    if (!filename) throw new Error('durable tombstone fixture missing');
    const file = path.join(directory, filename);
    vi.clearAllTimers();

    vi.resetModules();
    vi.setSystemTime(now);
    const restarted = await import('./node-tombstones.js');
    expect(restarted.isNodeTombstoned(root, 'canvas-a', 'node-a')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(restarted.NODE_TOMBSTONE_TTL_MS);
    expect(existsSync(file)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains timer cleanup errors and retries with backoff', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-10T00:00:00.000Z');
    vi.setSystemTime(now);
    const root = workspace();
    const first = await import('./node-tombstones.js');
    first.markNodeDeleted(root, 'canvas-a', 'node-a');
    const directory = workspaceTombstonesDir(root);
    const [filename] = readdirSync(directory);
    if (!filename) throw new Error('durable tombstone fixture missing');
    const file = path.join(directory, filename);
    vi.clearAllTimers();

    vi.resetModules();
    vi.setSystemTime(now);
    const restarted = await import('./node-tombstones.js');
    expect(restarted.isNodeTombstoned(root, 'canvas-a', 'node-a')).toBe(true);
    rmSync(file);
    mkdirSync(file);

    expect(() =>
      vi.advanceTimersByTime(restarted.NODE_TOMBSTONE_TTL_MS),
    ).not.toThrow();
    expect(existsSync(file)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    rmSync(file, { recursive: true });
    vi.advanceTimersByTime(restarted.NODE_TOMBSTONE_CLEANUP_RETRY_BASE_MS);
    expect(existsSync(file)).toBe(false);

    expect(
      restarted.nodeTombstoneRegistryStatsForTesting(root, 'canvas-a'),
    ).toMatchObject({ scopeLoaded: false, scopeLive: false });
  });

  it('bounds negative loaded-scope retention without evicting live semantics', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-10T00:00:00.000Z');
    vi.setSystemTime(now);
    const root = workspace();
    const cache = await import('./node-tombstones.js');
    cache.markNodeDeleted(root, 'live-canvas', 'live-node');
    expect(cache.isNodeTombstoned(root, 'canvas-0', 'node-a')).toBe(false);
    for (
      let index = 1;
      index <= cache.NODE_TOMBSTONE_EMPTY_SCOPE_CACHE_MAX + 1;
      index += 1
    ) {
      expect(cache.isNodeTombstoned(root, `canvas-${index}`, 'node-a')).toBe(
        false,
      );
    }

    const evicted = cache.nodeTombstoneRegistryStatsForTesting(
      root,
      'canvas-0',
    );
    expect(evicted.loadedScopeCount).toBeLessThanOrEqual(
      cache.NODE_TOMBSTONE_EMPTY_SCOPE_CACHE_MAX + evicted.liveScopeCount,
    );
    expect(evicted.scopeLoaded).toBe(false);
    expect(cache.isNodeTombstoned(root, 'live-canvas', 'live-node')).toBe(true);
    expect(
      cache.nodeTombstoneRegistryStatsForTesting(root, 'live-canvas'),
    ).toMatchObject({ scopeLoaded: true, scopeLive: true });
  });
});
