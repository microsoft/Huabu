// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioral contract for {@link SpaceNodes}. */

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeContent } from '../../../canvas/persistence-types.js';
import type { NodePutInput, SpaceNodes, NodeSnapshot } from '../structured.js';

export interface SpaceNodesContractHarness {
  /** Repository for an existing Space, initially empty at contract-owned ids. */
  readonly repository: SpaceNodes;
  /** Repository scoped to a Space whose structural record is absent. */
  readonly missingRepository: SpaceNodes;
  readonly expectedCanvasId: string;
  readonly cleanup?: () => Promise<void> | void;
}

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

async function putSuccessfully(
  repository: SpaceNodes,
  input: NodePutInput,
): Promise<NodeSnapshot> {
  const result = await repository.put(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected node put to succeed, got ${result.reason}`);
  }
  expect(result.revision).toEqual(expect.any(String));
  expect(result.revision).not.toHaveLength(0);
  return { record: result.record, revision: result.revision };
}

export function describeSpaceNodesContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceNodesContractHarness>
    | SpaceNodesContractHarness,
): void {
  describe(`SpaceNodes contract: ${name}`, () => {
    let harness: SpaceNodesContractHarness | null = null;

    async function open(): Promise<SpaceNodesContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('exposes the Space id that scopes the repository', async () => {
      const { repository, expectedCanvasId } = await open();

      expect(repository.canvasId).toBe(expectedCanvasId);
    });

    it('reads null for a missing node', async () => {
      const { repository } = await open();

      await expect(repository.read('contract-missing')).resolves.toBeNull();
    });

    it('returns the exact persisted record and its matching revision from put', async () => {
      const { repository } = await open();
      const input: NodePutInput = {
        nodeId: 'contract-exact-put',
        record: note('contract-exact-put', 'Contract node', 'requested'),
      };

      const result = await repository.put(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected node put to succeed');

      const persisted = await repository.read(input.nodeId);
      expect(persisted).not.toBeNull();
      if (persisted === null) {
        throw new Error('Expected the written node to be readable');
      }
      expect(result).toEqual({ ok: true, ...persisted });
      expect(result.revision).toEqual(expect.any(String));
      expect(result.revision).not.toHaveLength(0);
    });

    it('reports not-found without creating a node in an absent Space', async () => {
      const { missingRepository } = await open();
      const nodeId = 'contract-missing-space-node';

      await expect(
        missingRepository.put({
          nodeId,
          record: note(nodeId, 'Contract missing Space node', 'not stored'),
        }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
      await expect(missingRepository.read(nodeId)).resolves.toBeNull();
    });

    it('reports a stale revision without overwriting the current record', async () => {
      const { repository } = await open();
      const nodeId = 'contract-stale-revision';
      const baseline = await putSuccessfully(repository, {
        nodeId,
        record: note(nodeId, 'Contract revision node', 'baseline'),
      });
      const current = await putSuccessfully(repository, {
        nodeId,
        expectedRevision: baseline.revision,
        record: note(nodeId, 'Contract revision node', 'current'),
      });

      await expect(
        repository.put({
          nodeId,
          expectedRevision: baseline.revision,
          record: note(nodeId, 'Contract revision node', 'stale overwrite'),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'revision-conflict',
        currentRevision: current.revision,
      });
      await expect(repository.read(nodeId)).resolves.toEqual(current);
    });

    it('uses a full-record token, including label-only changes', async () => {
      const { repository } = await open();
      const nodeId = 'contract-full-record-revision';
      const baseline = await putSuccessfully(repository, {
        nodeId,
        record: note(nodeId, 'Original label', 'unchanged body'),
      });
      const renamed = await putSuccessfully(repository, {
        nodeId,
        expectedRevision: baseline.revision,
        record: note(nodeId, 'Renamed label', 'unchanged body'),
      });

      expect(renamed.revision).not.toBe(baseline.revision);
      await expect(
        repository.put({
          nodeId,
          expectedRevision: baseline.revision,
          record: note(nodeId, 'Stale label', 'unchanged body'),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'revision-conflict',
        currentRevision: renamed.revision,
      });
    });

    it('can compare-and-swap from explicit absence', async () => {
      const { repository } = await open();
      const nodeId = 'contract-expected-absent';
      const first = await putSuccessfully(repository, {
        nodeId,
        expectedRevision: null,
        record: note(nodeId, 'Expected absent', 'first'),
      });

      await expect(
        repository.put({
          nodeId,
          expectedRevision: null,
          record: note(nodeId, 'Expected absent', 'second'),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'revision-conflict',
        currentRevision: first.revision,
      });
    });

    it('de-duplicates labels unless strict label allocation is requested', async () => {
      const { repository } = await open();
      await putSuccessfully(repository, {
        nodeId: 'contract-label-owner',
        record: note('contract-label-owner', 'Contract shared label', 'one'),
      });
      const deduped = await putSuccessfully(repository, {
        nodeId: 'contract-label-deduped',
        record: note('contract-label-deduped', 'Contract shared label', 'two'),
      });
      expect(deduped.record.label).not.toBe('Contract shared label');

      await expect(
        repository.put({
          nodeId: 'contract-label-strict',
          record: note(
            'contract-label-strict',
            'Contract shared label',
            'three',
          ),
          strictLabel: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'label-conflict',
        conflictingNodeId: 'contract-label-owner',
        conflictingLabel: 'Contract shared label',
      });
    });

    it('rejects a mismatch between the addressed id and the record id', async () => {
      const { repository } = await open();

      await expect(
        repository.put({
          nodeId: 'contract-addressed-id',
          record: note(
            'contract-payload-id',
            'Contract mismatched node',
            'invalid',
          ),
        }),
      ).rejects.toThrow();
      await expect(
        repository.read('contract-addressed-id'),
      ).resolves.toBeNull();
      await expect(repository.read('contract-payload-id')).resolves.toBeNull();
    });

    it('deletes an existing node and reports subsequent absence', async () => {
      const { repository } = await open();
      const nodeId = 'contract-delete';
      await putSuccessfully(repository, {
        nodeId,
        record: note(nodeId, 'Contract delete node', 'delete me'),
      });

      await expect(repository.delete(nodeId)).resolves.toBe('deleted');
      await expect(repository.read(nodeId)).resolves.toBeNull();
      await expect(repository.delete(nodeId)).resolves.toBe('absent');
    });

    it('suppresses a late standalone put after deletion', async () => {
      const { repository } = await open();
      const nodeId = 'contract-late-put';
      const record = note(nodeId, 'Contract late put', 'before');
      await putSuccessfully(repository, { nodeId, record });
      await repository.delete(nodeId);

      await expect(
        repository.put({
          nodeId,
          record: { ...record, content: 'late resurrection' },
        }),
      ).resolves.toEqual({ ok: false, reason: 'write-suppressed' });
      await expect(repository.read(nodeId)).resolves.toBeNull();
    });
  });
}
