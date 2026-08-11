// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioural contract for a read-only {@link NodeRepository}. */

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeContent } from '../../../canvas/persistence-types.js';
import type { NodeRepository } from '../structured.js';

export interface NodeRepositoryHarness {
  repository: NodeRepository;
  existing: {
    record: NodeContent;
    logicalName: string;
  };
  missingNodeId: string;
  /** Fixture-only mutation used to prove that revisions cover every field. */
  replaceExisting(record: NodeContent): Promise<void> | void;
  cleanup?: () => Promise<void> | void;
}

export function describeNodeRepositoryContract(
  name: string,
  createHarness: () => Promise<NodeRepositoryHarness> | NodeRepositoryHarness,
): void {
  describe(`NodeRepository contract: ${name}`, () => {
    let harness: NodeRepositoryHarness | null = null;

    async function open(): Promise<NodeRepositoryHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reads null for a missing node', async () => {
      const { repository, missingNodeId } = await open();
      await expect(repository.read(missingNodeId)).resolves.toBeNull();
    });

    it('returns the complete record and its logical name', async () => {
      const { repository, existing } = await open();
      const snapshot = await repository.read(existing.record.nodeId);

      expect(snapshot).toMatchObject({
        record: existing.record,
        logicalName: existing.logicalName,
      });
      expect(snapshot?.revision).toEqual(expect.any(String));
      expect(snapshot?.revision).not.toHaveLength(0);
    });

    it('returns a stable revision for unchanged state', async () => {
      const { repository, existing } = await open();
      const first = await repository.read(existing.record.nodeId);
      const second = await repository.read(existing.record.nodeId);

      expect(second?.revision).toBe(first?.revision);
    });

    it('revises the snapshot when a non-content record field changes', async () => {
      const { repository, existing, replaceExisting } = await open();
      const before = await repository.read(existing.record.nodeId);
      const next = {
        ...existing.record,
        repositoryContractMetadata: {
          nested: { value: 'changed' },
        },
      };

      await replaceExisting(next);
      const after = await repository.read(existing.record.nodeId);

      expect(after?.record).toEqual(next);
      expect(after?.revision).not.toBe(before?.revision);
    });

    it('batch-reads requested records, omits misses, and coalesces ids', async () => {
      const { repository, existing, missingNodeId } = await open();
      const snapshots = await repository.readMany([
        existing.record.nodeId,
        missingNodeId,
        existing.record.nodeId,
      ]);

      expect([...snapshots.keys()]).toEqual([existing.record.nodeId]);
      expect(snapshots.get(existing.record.nodeId)).toMatchObject({
        record: existing.record,
        logicalName: existing.logicalName,
      });
      expect(snapshots.has(missingNodeId)).toBe(false);
    });

    it('exposes no node mutation method', async () => {
      const { repository } = await open();
      for (const method of ['write', 'put', 'delete', 'compareAndSwap']) {
        expect(repository).not.toHaveProperty(method);
      }
    });
  });
}
