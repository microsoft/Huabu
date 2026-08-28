// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable minimum contract for the backend-neutral Space collection:
 * membership, World identity, and ordinary create/delete/rename.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceRepository } from '../structured.js';

export interface SpaceRepositoryContractHarness {
  /**
   * Repository under test, bound to one isolated backend namespace that
   * contains World and no ordinary Spaces yet.
   */
  readonly repository: SpaceRepository;
  /** Read structured state without going through a compatibility facade. */
  readonly read: (canvasId: string) => Promise<CanvasFile | null>;
  /** Stable World id in the harness namespace. */
  readonly worldCanvasId: string;
  /** One representative portable mutation for deletion-fence checks. */
  readonly attemptMutation: (canvasId: string) => Promise<unknown>;
  /**
   * Bind to a namespace that has never been mounted — no World, no Spaces.
   *
   * This is the state every backend meets first, and the only place the
   * creating branch of {@link SpaceRepository.ensureWorld} can be observed;
   * the main harness namespace always has a World already. Invalidating the
   * other harness members is allowed: a case that opens this uses nothing
   * else afterwards.
   */
  readonly openEmptyNamespace: () =>
    | Promise<EmptyNamespaceHarness>
    | EmptyNamespaceHarness;
  readonly cleanup?: () => Promise<void> | void;
}

/** A backend namespace with nothing in it yet. */
export interface EmptyNamespaceHarness {
  readonly repository: SpaceRepository;
  readonly read: (canvasId: string) => Promise<CanvasFile | null>;
}

export function describeSpaceRepositoryContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceRepositoryContractHarness>
    | SpaceRepositoryContractHarness,
): void {
  describe(`SpaceRepository contract: ${name}`, () => {
    let harness: SpaceRepositoryContractHarness | null = null;

    async function open(): Promise<SpaceRepositoryContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('lists no ordinary Space in a namespace that only contains World', async () => {
      const { repository } = await open();

      await expect(repository.list()).resolves.toEqual([]);
    });

    it('lists created ordinary Spaces without promising order', async () => {
      const { repository } = await open();
      const first = await repository.create({
        canvasId: 'contract-list-a',
        title: 'Contract list A',
      });
      const second = await repository.create({
        canvasId: 'contract-list-b',
        title: null,
      });
      if (!first.ok || !second.ok)
        throw new Error('Expected create to succeed');

      const rows = await repository.list();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining(
          [first.record, second.record].map((record) => ({
            canvasId: record.canvasId,
            title: record.title,
            nodeCount: 0,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })),
        ),
      );
    });

    it('returns a stable World id that is excluded from ordinary listings', async () => {
      const { repository, worldCanvasId } = await open();
      const created = await repository.create({
        canvasId: 'contract-world-exclusion',
        title: 'Not World',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      await expect(repository.worldId()).resolves.toBe(worldCanvasId);
      await expect(repository.worldId()).resolves.toBe(worldCanvasId);
      expect(
        (await repository.list()).map((row) => row.canvasId),
      ).not.toContain(worldCanvasId);
    });

    it('returns the established World from ensureWorld without replacing it', async () => {
      const { repository, worldCanvasId, read } = await open();
      const before = await read(worldCanvasId);

      await expect(repository.ensureWorld()).resolves.toBe(worldCanvasId);
      await expect(repository.ensureWorld()).resolves.toBe(worldCanvasId);

      // Identity is what Portals reference, so a bootstrap that ran against an
      // established World must be indistinguishable from not having run.
      await expect(read(worldCanvasId)).resolves.toEqual(before);
      expect(
        (await repository.list()).map((row) => row.canvasId),
      ).not.toContain(worldCanvasId);
    });

    it('bootstraps exactly one version-0 World in an empty namespace', async () => {
      const { openEmptyNamespace } = await open();
      const { repository, read } = await openEmptyNamespace();

      const worldCanvasId = await repository.ensureWorld();
      expect(worldCanvasId).toEqual(expect.any(String));
      expect(worldCanvasId).not.toHaveLength(0);

      const created = await read(worldCanvasId);
      expect(created).toMatchObject({
        canvasId: worldCanvasId,
        version: 0,
        state: { nodes: [], edges: [] },
      });

      // Idempotent, and the World it minted is the one `worldId()` resolves —
      // a second bootstrap that minted a second identity would orphan every
      // Portal written against the first.
      await expect(repository.ensureWorld()).resolves.toBe(worldCanvasId);
      await expect(repository.worldId()).resolves.toBe(worldCanvasId);
      await expect(read(worldCanvasId)).resolves.toEqual(created);
      await expect(repository.list()).resolves.toEqual([]);
    });

    it('creates and returns the authoritative empty version-0 record', async () => {
      const { repository, read } = await open();
      const result = await repository.create({
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
      if (!result.ok) throw new Error('Expected create to succeed');
      expect(Number.isFinite(result.record.createdAt)).toBe(true);
      expect(Number.isFinite(result.record.updatedAt)).toBe(true);
      await expect(read('contract-created')).resolves.toEqual(result.record);
    });

    it('preserves a null title in the authoritative record', async () => {
      const { repository, read } = await open();
      const result = await repository.create({
        canvasId: 'contract-untitled',
        title: null,
      });

      expect(result).toMatchObject({
        ok: true,
        record: { canvasId: 'contract-untitled', title: null, version: 0 },
      });
      if (!result.ok) throw new Error('Expected create to succeed');
      await expect(read('contract-untitled')).resolves.toEqual(result.record);
    });

    it('preserves a null title when its physical name needs de-duplication', async () => {
      const { repository, read } = await open();
      const owner = await repository.create({
        canvasId: 'contract-null-owner',
        title: 'Contract-Null-Collision',
      });
      if (!owner.ok) throw new Error('Expected collision owner to succeed');

      const result = await repository.create({
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
      const { repository, read } = await open();
      const results = await Promise.all([
        repository.create({ canvasId: 'contract-race', title: 'First' }),
        repository.create({ canvasId: 'contract-race', title: 'Second' }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: 'already-exists' },
      ]);
      const winner = results.find((result) => result.ok);
      if (!winner?.ok) throw new Error('Expected one create winner');
      await expect(read('contract-race')).resolves.toEqual(winner.record);
    });

    it('reports an existing id without replacing its record', async () => {
      const { repository, read } = await open();
      const first = await repository.create({
        canvasId: 'contract-existing',
        title: 'Original',
      });
      if (!first.ok) throw new Error('Expected create to succeed');

      await expect(
        repository.create({
          canvasId: 'contract-existing',
          title: 'Replacement',
        }),
      ).resolves.toEqual({ ok: false, reason: 'already-exists' });
      await expect(read('contract-existing')).resolves.toEqual(first.record);
    });

    it('preserves the existing title-allocation rule for distinct ids', async () => {
      const { repository, read } = await open();
      const first = await repository.create({
        canvasId: 'contract-title-a',
        title: 'Shared title',
      });
      const second = await repository.create({
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
      const { repository, read } = await open();
      const trailingA = await repository.create({
        canvasId: 'contract-trailing-a',
        title: 'Trailing title ',
      });
      const trailingB = await repository.create({
        canvasId: 'contract-trailing-b',
        title: 'Trailing title ',
      });
      const longTitle = 'L'.repeat(140);
      const longA = await repository.create({
        canvasId: 'contract-long-a',
        title: longTitle,
      });
      const longB = await repository.create({
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
      const { repository, read } = await open();
      const created = await repository.create({
        canvasId: 'contract-rename',
        title: 'Before rename',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const renamed = await repository.rename({
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
      if (!renamed.ok) throw new Error('Expected rename to succeed');
      await expect(read('contract-rename')).resolves.toEqual(renamed.record);
    });

    it('persists distinct logical titles even when a backend locator is unchanged', async () => {
      const { repository, read } = await open();
      const created = await repository.create({
        canvasId: 'contract-logical-rename',
        title: 'A/B',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const renamed = await repository.rename({
        canvasId: 'contract-logical-rename',
        title: 'A:B',
      });
      expect(renamed).toMatchObject({
        ok: true,
        record: { title: 'A:B', version: 0 },
      });
      if (!renamed.ok) throw new Error('Expected rename to succeed');
      await expect(read('contract-logical-rename')).resolves.toEqual(
        renamed.record,
      );
    });

    it('reports the existing logical title on a rename collision', async () => {
      const { repository } = await open();
      const owner = await repository.create({
        canvasId: 'contract-title-owner',
        title: 'Contract/A',
      });
      const target = await repository.create({
        canvasId: 'contract-title-target',
        title: 'Before conflict',
      });
      if (!owner.ok || !target.ok) {
        throw new Error('Expected create to succeed');
      }

      await expect(
        repository.rename({
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
      const { repository, read } = await open();
      const owner = await repository.create({
        canvasId: 'contract-null-rename-owner',
        title: 'contract-null-rename',
      });
      const created = await repository.create({
        canvasId: 'contract-null-rename',
        title: null,
      });
      if (!owner.ok || !created.ok) {
        throw new Error('Expected create to succeed');
      }

      await expect(
        repository.rename({
          canvasId: 'contract-null-rename',
          title: null,
        }),
      ).resolves.toEqual({ ok: true, record: created.record });
      await expect(read('contract-null-rename')).resolves.toEqual(
        created.record,
      );
    });

    it('can clear an existing title without substituting a backend locator', async () => {
      const { repository, read } = await open();
      const created = await repository.create({
        canvasId: 'contract-clear-title',
        title: 'Clear me',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const renamed = await repository.rename({
        canvasId: 'contract-clear-title',
        title: null,
      });
      expect(renamed).toMatchObject({
        ok: true,
        record: { title: null, version: 0 },
      });
      if (!renamed.ok) throw new Error('Expected rename to succeed');
      await expect(read('contract-clear-title')).resolves.toEqual(
        renamed.record,
      );
    });

    it('reports not-found when renaming an absent Space', async () => {
      const { repository } = await open();

      await expect(
        repository.rename({
          canvasId: 'contract-missing-rename',
          title: 'Missing',
        }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    });

    it('deletes structured state and reports an idempotent not-found outcome', async () => {
      const { repository, read } = await open();
      const created = await repository.create({
        canvasId: 'contract-delete',
        title: 'Delete me',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const first = await repository.beginDelete({
        canvasId: 'contract-delete',
      });
      if (!first.ok) throw new Error('Ordinary Space must be deletable');
      await expect(first.session.finish()).resolves.toEqual({
        ok: true,
        reason: 'deleted',
      });
      await expect(read('contract-delete')).resolves.toBeNull();
      const second = await repository.beginDelete({
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
      const { repository } = await open();

      const result = await repository.beginDelete({
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
      const { repository, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();

      await expect(
        repository.beginDelete({ canvasId: worldCanvasId }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });

    it('fences mutations until deletion finishes or aborts', async () => {
      const { repository, read, attemptMutation } = await open();
      const created = await repository.create({
        canvasId: 'contract-delete-fence',
        title: 'Deletion fence',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const started = await repository.beginDelete({
        canvasId: 'contract-delete-fence',
      });
      if (!started.ok) throw new Error('Ordinary Space must be deletable');
      await expect(attemptMutation('contract-delete-fence')).rejects.toThrow();
      await expect(
        repository.rename({
          canvasId: 'contract-delete-fence',
          title: 'Too late',
        }),
      ).rejects.toThrow();
      await expect(
        repository.rename({
          canvasId: 'contract-delete-fence',
          title: created.record.title,
        }),
      ).rejects.toThrow();
      await expect(
        repository.create({
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
      const { repository } = await open();
      const created = await repository.create({
        canvasId: 'contract-delete-queue',
        title: 'Deletion queue',
      });
      if (!created.ok) throw new Error('Expected create to succeed');

      const first = await repository.beginDelete({
        canvasId: 'contract-delete-queue',
      });
      if (!first.ok) throw new Error('Ordinary Space must be deletable');
      let secondSettled = false;
      const secondPromise = repository
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
      const { repository, read, worldCanvasId } = await open();
      const before = await read(worldCanvasId);
      expect(before).not.toBeNull();
      if (before === null) throw new Error('Expected World to exist');

      await expect(
        repository.rename({ canvasId: worldCanvasId, title: 'Not World' }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(
        repository.rename({ canvasId: worldCanvasId, title: before.title }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      await expect(read(worldCanvasId)).resolves.toEqual(before);
    });
  });
}
