// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable backend-neutral contract for Space membership lifecycle. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceLifecycleRepository } from '../structured.js';

export interface SpaceLifecycleContractHarness {
  readonly lifecycle: SpaceLifecycleRepository;
  readonly read: (canvasId: string) => Promise<CanvasFile | null>;
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

    it('creates one empty version-0 record and reports its effective title', async () => {
      const { lifecycle, read } = await open();
      const created = await lifecycle.create({
        canvasId: 'created-space',
        title: 'Created Space',
      });

      expect(created).toMatchObject({
        ok: true,
        effectiveTitle: 'Created Space',
        record: {
          canvasId: 'created-space',
          title: 'Created Space',
          version: 0,
          state: { nodes: [], edges: [] },
        },
      });
      await expect(read('created-space')).resolves.toEqual(
        created.ok ? created.record : null,
      );
    });

    it('selects exactly one winner for concurrent same-id creation', async () => {
      const { lifecycle } = await open();
      const outcomes = await Promise.all([
        lifecycle.create({ canvasId: 'same-id', title: 'First' }),
        lifecycle.create({ canvasId: 'same-id', title: 'Second' }),
      ]);

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reason: 'already-exists' },
      ]);
    });

    it('de-duplicates colliding titles and returns the persisted title', async () => {
      const { lifecycle, read } = await open();
      await lifecycle.create({ canvasId: 'title-a', title: 'Shared' });
      const second = await lifecycle.create({
        canvasId: 'title-b',
        title: 'Shared',
      });

      expect(second).toMatchObject({
        ok: true,
        effectiveTitle: 'Shared (2)',
        record: { title: 'Shared (2)' },
      });
      await expect(read('title-b')).resolves.toMatchObject({
        title: 'Shared (2)',
      });
    });

    it('runs independent cleanup before removing the structured record', async () => {
      const { lifecycle, read } = await open();
      await lifecycle.create({ canvasId: 'delete-me', title: 'Delete Me' });
      const recordVisibleAtCleanup: boolean[] = [];

      const result = await lifecycle.delete({
        canvasId: 'delete-me',
        beforeRemove: async () => {
          recordVisibleAtCleanup.push((await read('delete-me')) !== null);
        },
      });

      expect(result).toEqual({ ok: true, reason: 'deleted' });
      expect(recordVisibleAtCleanup).toEqual([true]);
      await expect(read('delete-me')).resolves.toBeNull();
      await expect(
        lifecycle.delete({ canvasId: 'delete-me' }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    });

    it('keeps deletion retryable when independent cleanup rejects', async () => {
      const { lifecycle, read } = await open();
      await lifecycle.create({ canvasId: 'retry-me', title: 'Retry Me' });

      await expect(
        lifecycle.delete({
          canvasId: 'retry-me',
          beforeRemove: async () => {
            throw new Error('blob sweep failed');
          },
        }),
      ).rejects.toThrow('blob sweep failed');
      await expect(read('retry-me')).resolves.toMatchObject({
        canvasId: 'retry-me',
      });
    });

    it('refuses World without invoking independent cleanup', async () => {
      const { lifecycle, worldCanvasId, read } = await open();
      const beforeRemove = vi.fn(async () => undefined);

      await expect(
        lifecycle.delete({ canvasId: worldCanvasId, beforeRemove }),
      ).resolves.toEqual({ ok: false, reason: 'world-forbidden' });
      expect(beforeRemove).not.toHaveBeenCalled();
      await expect(read(worldCanvasId)).resolves.not.toBeNull();
    });
  });
}
