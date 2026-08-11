// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable minimum contract for backend-neutral Space lifecycle adapters. */

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceLifecycleRepository } from '../structured.js';

export interface SpaceLifecycleContractHarness {
  /** Repository under test, bound to one isolated backend namespace. */
  readonly lifecycle: SpaceLifecycleRepository;
  /** Read structured state without going through a compatibility facade. */
  readonly read: (canvasId: string) => Promise<CanvasFile | null>;
  /** Stable World id in the harness namespace. */
  readonly worldCanvasId: string;
  readonly cleanup?: () => Promise<void> | void;
}

export function describeSpaceLifecycleContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceLifecycleContractHarness>
    | SpaceLifecycleContractHarness,
): void {
  describe(`SpaceLifecycleRepository contract: ${name}`, () => {
    let harness: SpaceLifecycleContractHarness | null = null;

    async function open(): Promise<SpaceLifecycleContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('creates and returns the authoritative empty version-0 record', async () => {
      const { lifecycle, read } = await open();
      const result = await lifecycle.create({
        canvasId: 'contract-created',
        title: 'Contract Space',
      });

      expect(result).toMatchObject({
        ok: true,
        record: {
          canvasId: 'contract-created',
          title: 'Contract Space',
          version: 0,
          state: { nodes: [], edges: [] },
        },
      });
      if (!result.ok) throw new Error('Expected lifecycle create to succeed');
      expect(Number.isFinite(result.record.createdAt)).toBe(true);
      expect(Number.isFinite(result.record.updatedAt)).toBe(true);
      await expect(read('contract-created')).resolves.toEqual(result.record);
    });

    it('preserves a null title in the authoritative record', async () => {
      const { lifecycle, read } = await open();
      const result = await lifecycle.create({
        canvasId: 'contract-untitled',
        title: null,
      });

      expect(result).toMatchObject({
        ok: true,
        record: { canvasId: 'contract-untitled', title: null, version: 0 },
      });
      if (!result.ok) throw new Error('Expected lifecycle create to succeed');
      await expect(read('contract-untitled')).resolves.toEqual(result.record);
    });

    it('selects exactly one winner for concurrent same-id creation', async () => {
      const { lifecycle, read } = await open();
      const results = await Promise.all([
        lifecycle.create({ canvasId: 'contract-race', title: 'First' }),
        lifecycle.create({ canvasId: 'contract-race', title: 'Second' }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: 'already-exists' },
      ]);
      const winner = results.find((result) => result.ok);
      if (!winner?.ok) throw new Error('Expected one lifecycle winner');
      await expect(read('contract-race')).resolves.toEqual(winner.record);
    });

    it('reports an existing id without replacing its record', async () => {
      const { lifecycle, read } = await open();
      const first = await lifecycle.create({
        canvasId: 'contract-existing',
        title: 'Original',
      });
      if (!first.ok) throw new Error('Expected lifecycle create to succeed');

      await expect(
        lifecycle.create({
          canvasId: 'contract-existing',
          title: 'Replacement',
        }),
      ).resolves.toEqual({ ok: false, reason: 'already-exists' });
      await expect(read('contract-existing')).resolves.toEqual(first.record);
    });

    it('preserves the existing title-allocation rule for distinct ids', async () => {
      const { lifecycle, read } = await open();
      const first = await lifecycle.create({
        canvasId: 'contract-title-a',
        title: 'Shared title',
      });
      const second = await lifecycle.create({
        canvasId: 'contract-title-b',
        title: 'Shared title',
      });

      if (!first.ok || !second.ok) {
        throw new Error('A title is not Space identity');
      }
      expect(first.record.title).toBe('Shared title');
      expect(second.record.title).toBe('Shared title (2)');
      await expect(read('contract-title-a')).resolves.toEqual(first.record);
      await expect(read('contract-title-b')).resolves.toEqual(second.record);
    });

    it('renames an existing Space and returns the authoritative record', async () => {
      const { lifecycle, read } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-rename',
        title: 'Before rename',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      const renamed = await lifecycle.rename({
        canvasId: 'contract-rename',
        title: 'After rename',
      });
      expect(renamed).toMatchObject({
        ok: true,
        record: {
          canvasId: 'contract-rename',
          title: 'After rename',
          version: 0,
        },
      });
      if (!renamed.ok) throw new Error('Expected lifecycle rename to succeed');
      await expect(read('contract-rename')).resolves.toEqual(renamed.record);
    });

    it('reports not-found when renaming an absent Space', async () => {
      const { lifecycle } = await open();

      await expect(
        lifecycle.rename({
          canvasId: 'contract-missing-rename',
          title: 'Missing',
        }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    });

    it('deletes structured state and reports an idempotent not-found outcome', async () => {
      const { lifecycle, read } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-delete',
        title: 'Delete me',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      await expect(
        lifecycle.delete({ canvasId: 'contract-delete' }),
      ).resolves.toEqual({ ok: true, reason: 'deleted' });
      await expect(read('contract-delete')).resolves.toBeNull();
      await expect(
        lifecycle.delete({ canvasId: 'contract-delete' }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    });

    it('reports not-found for an id that never existed', async () => {
      const { lifecycle } = await open();

      await expect(
        lifecycle.delete({ canvasId: 'contract-missing' }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    });

    it('refuses to delete World and leaves its record intact', async () => {
      const { lifecycle, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();

      await expect(
        lifecycle.delete({ canvasId: worldCanvasId }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });

    it('refuses to rename World and leaves its record intact', async () => {
      const { lifecycle, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();

      await expect(
        lifecycle.rename({ canvasId: worldCanvasId, title: 'Not World' }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });
  });
}
