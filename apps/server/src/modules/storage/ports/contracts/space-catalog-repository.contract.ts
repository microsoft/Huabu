/** Reusable behavioral contract for backend Space catalogues. */

import { afterEach, describe, expect, it } from 'vitest';

import type { SpaceCatalogRepository } from '../structured.js';
import type { CanvasSummary } from '@sediment/shared';

export type SpaceCatalogContractScenario = 'populated' | 'empty';

export interface SpaceCatalogContractHarness {
  repository: SpaceCatalogRepository;
  expectedSummaries: CanvasSummary[];
  expectedWorldId: string;
  cleanup?: () => Promise<void> | void;
}

export function describeSpaceCatalogRepositoryContract(
  name: string,
  createHarness: (
    scenario: SpaceCatalogContractScenario,
  ) => Promise<SpaceCatalogContractHarness> | SpaceCatalogContractHarness,
): void {
  describe(`SpaceCatalogRepository contract: ${name}`, () => {
    let harness: SpaceCatalogContractHarness | null = null;

    async function open(
      scenario: SpaceCatalogContractScenario,
    ): Promise<SpaceCatalogContractHarness> {
      harness = await createHarness(scenario);
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('lists complete ordinary-Space summaries without promising order', async () => {
      const current = await open('populated');
      const rows = await current.repository.list();

      expect(rows).toHaveLength(current.expectedSummaries.length);
      expect(rows).toEqual(expect.arrayContaining(current.expectedSummaries));
    });

    it('returns an empty list when the catalogue only contains World', async () => {
      const current = await open('empty');

      await expect(current.repository.list()).resolves.toEqual([]);
    });

    it('returns a stable World id that is excluded from ordinary listings', async () => {
      const current = await open('populated');

      await expect(current.repository.worldId()).resolves.toBe(
        current.expectedWorldId,
      );
      await expect(current.repository.worldId()).resolves.toBe(
        current.expectedWorldId,
      );
      expect(
        (await current.repository.list()).map((row) => row.canvasId),
      ).not.toContain(current.expectedWorldId);
    });
  });
}
