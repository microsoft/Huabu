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
  /** One representative portable mutation for deletion-fence checks. */
  readonly attemptMutation: (canvasId: string) => Promise<unknown>;
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

    it('preserves a null title when its physical name needs de-duplication', async () => {
      const { lifecycle, read } = await open();
      const owner = await lifecycle.create({
        canvasId: 'contract-null-owner',
        title: 'Contract-Null-Collision',
      });
      if (!owner.ok) throw new Error('Expected collision owner to succeed');

      const result = await lifecycle.create({
        canvasId: 'contract-null-collision',
        title: null,
      });

      expect(result).toMatchObject({
        ok: true,
        record: { canvasId: 'contract-null-collision', title: null },
      });
      if (!result.ok) throw new Error('Expected null-title create to succeed');
      await expect(read('contract-null-collision')).resolves.toEqual(
        result.record,
      );
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

    it('returns the authoritative title when backend normalization affects allocation', async () => {
      const { lifecycle, read } = await open();
      const trailingA = await lifecycle.create({
        canvasId: 'contract-trailing-a',
        title: 'Trailing title ',
      });
      const trailingB = await lifecycle.create({
        canvasId: 'contract-trailing-b',
        title: 'Trailing title ',
      });
      const longTitle = 'L'.repeat(140);
      const longA = await lifecycle.create({
        canvasId: 'contract-long-a',
        title: longTitle,
      });
      const longB = await lifecycle.create({
        canvasId: 'contract-long-b',
        title: longTitle,
      });

      for (const [canvasId, result] of [
        ['contract-trailing-a', trailingA],
        ['contract-trailing-b', trailingB],
        ['contract-long-a', longA],
        ['contract-long-b', longB],
      ] as const) {
        if (!result.ok) throw new Error(`Expected ${canvasId} to be created`);
        await expect(read(canvasId)).resolves.toEqual(result.record);
      }
      if (!trailingA.ok || !trailingB.ok || !longA.ok || !longB.ok) return;
      expect(trailingB.record.title).not.toBe(trailingA.record.title);
      expect(longB.record.title).not.toBe(longA.record.title);
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

    it('persists distinct logical titles even when a backend locator is unchanged', async () => {
      const { lifecycle, read } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-logical-rename',
        title: 'A/B',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      const renamed = await lifecycle.rename({
        canvasId: 'contract-logical-rename',
        title: 'A:B',
      });
      expect(renamed).toMatchObject({
        ok: true,
        record: { title: 'A:B', version: 0 },
      });
      if (!renamed.ok) throw new Error('Expected lifecycle rename to succeed');
      await expect(read('contract-logical-rename')).resolves.toEqual(
        renamed.record,
      );
    });

    it('reports the existing logical title on a rename collision', async () => {
      const { lifecycle } = await open();
      const owner = await lifecycle.create({
        canvasId: 'contract-title-owner',
        title: 'Contract/A',
      });
      const target = await lifecycle.create({
        canvasId: 'contract-title-target',
        title: 'Before conflict',
      });
      if (!owner.ok || !target.ok) {
        throw new Error('Expected lifecycle create to succeed');
      }

      await expect(
        lifecycle.rename({
          canvasId: 'contract-title-target',
          title: 'Contract:A',
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'title-conflict',
        conflictingTitle: 'Contract/A',
      });
    });

    it('treats an unchanged null logical title as an idempotent rename', async () => {
      const { lifecycle, read } = await open();
      const owner = await lifecycle.create({
        canvasId: 'contract-null-rename-owner',
        title: 'contract-null-rename',
      });
      const created = await lifecycle.create({
        canvasId: 'contract-null-rename',
        title: null,
      });
      if (!owner.ok || !created.ok) {
        throw new Error('Expected lifecycle create to succeed');
      }

      await expect(
        lifecycle.rename({
          canvasId: 'contract-null-rename',
          title: null,
        }),
      ).resolves.toEqual({ ok: true, record: created.record });
      await expect(read('contract-null-rename')).resolves.toEqual(
        created.record,
      );
    });

    it('can clear an existing title without substituting a backend locator', async () => {
      const { lifecycle, read } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-clear-title',
        title: 'Clear me',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      const renamed = await lifecycle.rename({
        canvasId: 'contract-clear-title',
        title: null,
      });
      expect(renamed).toMatchObject({
        ok: true,
        record: { title: null, version: 0 },
      });
      if (!renamed.ok) throw new Error('Expected lifecycle rename to succeed');
      await expect(read('contract-clear-title')).resolves.toEqual(
        renamed.record,
      );
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

      const first = await lifecycle.beginDelete({
        canvasId: 'contract-delete',
      });
      if (!first.ok) throw new Error('Ordinary Space must be deletable');
      await expect(first.session.finish()).resolves.toEqual({
        ok: true,
        reason: 'deleted',
      });
      await expect(read('contract-delete')).resolves.toBeNull();
      const second = await lifecycle.beginDelete({
        canvasId: 'contract-delete',
      });
      if (!second.ok)
        throw new Error('Missing ordinary Space must be cleanable');
      await expect(second.session.finish()).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
    });

    it('returns a session for an absent id so orphan cleanup can run', async () => {
      const { lifecycle } = await open();

      const result = await lifecycle.beginDelete({
        canvasId: 'contract-missing',
      });
      if (!result.ok)
        throw new Error('Missing ordinary Space must be cleanable');
      await expect(result.session.finish()).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
    });

    it('refuses to delete World and leaves its record intact', async () => {
      const { lifecycle, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();

      await expect(
        lifecycle.beginDelete({ canvasId: worldCanvasId }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });

    it('fences mutations until deletion finishes or aborts', async () => {
      const { lifecycle, read, attemptMutation } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-delete-fence',
        title: 'Deletion fence',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      const started = await lifecycle.beginDelete({
        canvasId: 'contract-delete-fence',
      });
      if (!started.ok) throw new Error('Ordinary Space must be deletable');
      await expect(attemptMutation('contract-delete-fence')).rejects.toThrow();
      await expect(
        lifecycle.rename({
          canvasId: 'contract-delete-fence',
          title: 'Too late',
        }),
      ).rejects.toThrow();
      await expect(
        lifecycle.rename({
          canvasId: 'contract-delete-fence',
          title: created.record.title,
        }),
      ).rejects.toThrow();
      await expect(
        lifecycle.create({
          canvasId: 'contract-delete-fence',
          title: 'Too late',
        }),
      ).rejects.toThrow();
      await expect(read('contract-delete-fence')).resolves.toEqual(
        created.record,
      );

      await started.session.abort();
      await started.session.abort();
      await expect(
        attemptMutation('contract-delete-fence'),
      ).resolves.toBeDefined();
      await expect(started.session.finish()).rejects.toThrow(/closed/);
    });

    it('serializes concurrent deletion sessions for one Space', async () => {
      const { lifecycle } = await open();
      const created = await lifecycle.create({
        canvasId: 'contract-delete-queue',
        title: 'Deletion queue',
      });
      if (!created.ok) throw new Error('Expected lifecycle create to succeed');

      const first = await lifecycle.beginDelete({
        canvasId: 'contract-delete-queue',
      });
      if (!first.ok) throw new Error('Ordinary Space must be deletable');
      let secondSettled = false;
      const secondPromise = lifecycle
        .beginDelete({ canvasId: 'contract-delete-queue' })
        .finally(() => {
          secondSettled = true;
        });
      await Promise.resolve();
      expect(secondSettled).toBe(false);

      await first.session.abort();
      const second = await secondPromise;
      if (!second.ok) throw new Error('Ordinary Space must be deletable');
      await second.session.abort();
    });

    it('refuses to rename World and leaves its record intact', async () => {
      const { lifecycle, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();
      if (before === null) throw new Error('Expected World to exist');

      await expect(
        lifecycle.rename({ canvasId: worldCanvasId, title: 'Not World' }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(
        lifecycle.rename({ canvasId: worldCanvasId, title: before.title }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });
  });
}
