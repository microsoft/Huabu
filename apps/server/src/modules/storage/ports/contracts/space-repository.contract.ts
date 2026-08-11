// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioural contract for a read-only {@link SpaceRepository}. */

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceRepository } from '../structured.js';

export interface SpaceRepositoryHarness {
  repository: SpaceRepository;
  expected: CanvasFile;
  missing: SpaceRepository;
  cleanup?: () => Promise<void> | void;
}

export function describeSpaceRepositoryContract(
  name: string,
  createHarness: () => Promise<SpaceRepositoryHarness> | SpaceRepositoryHarness,
): void {
  describe(`SpaceRepository contract: ${name}`, () => {
    let harness: SpaceRepositoryHarness | null = null;

    async function open(): Promise<SpaceRepositoryHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reads null for a Space with no record', async () => {
      const { missing } = await open();
      await expect(missing.read()).resolves.toBeNull();
    });

    it('reads the complete current record', async () => {
      const { repository, expected } = await open();
      await expect(repository.read()).resolves.toEqual(expected);
    });

    it('exposes no record mutation method', async () => {
      const { repository } = await open();
      expect(repository).not.toHaveProperty('compareAndSwap');
      expect(Object.keys(repository)).toEqual([]);
    });
  });
}
