// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioral contract for {@link SpaceNodes}. */

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  NodePutInput,
  NodeSnapshot,
  SpaceHandle,
  SpaceNodes,
} from '../structured.js';

export interface SpaceNodesContractHarness {
  /** Repository for an existing Space, initially empty at contract-owned ids. */
  readonly repository: SpaceNodes;
  /** Repository scoped to a Space whose structural record is absent. */
  readonly missingRepository: SpaceNodes;
  readonly expectedCanvasId: string;
  /** Whether this adapter fences a deleted id against late standalone puts. */
  readonly deletedNodePut: 'allowed' | 'write-suppressed';
  /** The Space {@link repository} belongs to, for writes that carry nodes. */
  readonly space?: SpaceHandle;
  /**
   * The same Space's nodes through a store opened afresh, as after a restart.
   * Omitted by a harness that cannot reopen its backend.
   */
  readonly reopen?: () => Promise<SpaceNodes> | SpaceNodes;
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

    it('round-trips authored properties, reordered keys and owned notes including explicit clearing', async () => {
      const { repository } = await open();
      const nodeId = 'contract-properties';
      const record: NodeContent = {
        ...note(nodeId, 'Properties', 'body'),
        properties: {
          title: 'Paper',
          year: 2026,
          reviewed: false,
          authors: ['Ada', 'Grace'],
          empty: '',
        },
        propertyDisplayKeys: ['year', 'reviewed'],
      };
      const first = await putSuccessfully(repository, { nodeId, record });
      expect((await repository.read(nodeId))?.record).toEqual(record);
      const reordered = await putSuccessfully(repository, {
        nodeId,
        record: { ...record, propertyDisplayKeys: ['reviewed', 'year'] },
        expectedRevision: first.revision,
      });
      expect(
        (await repository.read(nodeId))?.record.propertyDisplayKeys,
      ).toEqual(['reviewed', 'year']);
      expect(reordered.revision).not.toBe(first.revision);
      const cleared = {
        ...record,
        properties: { reviewed: true },
        propertyDisplayKeys: [],
      };
      const second = await putSuccessfully(repository, {
        nodeId,
        record: cleared,
        expectedRevision: reordered.revision,
      });
      expect(second.revision).not.toBe(first.revision);
      expect((await repository.list()).get(nodeId)?.record).toEqual(cleared);
      expect((await repository.readMany([nodeId])).get(nodeId)?.record).toEqual(
        cleared,
      );
      expect(
        (await repository.stream(() => undefined)).get(nodeId)?.record,
      ).toEqual(cleared);
      const stale = await repository.put({
        nodeId,
        record,
        expectedRevision: first.revision,
      });
      expect(stale).toMatchObject({ ok: false, reason: 'revision-conflict' });
    });

    /**
     * The four read shapes are one view of one collection.
     *
     * Each is free to reach the backend differently — a lookup by id, a
     * selection, a scan, a scan that yields — so what has to be asserted is
     * that they never disagree about a node. An adapter whose scan parsed
     * records more leniently than its single read, or minted a different
     * revision, would pass every test written against one shape alone.
     */
    it('agrees across read, readMany, list, and stream', async () => {
      const { repository } = await open();
      const ids = ['contract-agree-a', 'contract-agree-b', 'contract-agree-c'];
      for (const nodeId of ids) {
        await putSuccessfully(repository, {
          nodeId,
          record: note(nodeId, `Contract ${nodeId}`, `body of ${nodeId}`),
        });
      }

      const listed = await repository.list();
      for (const nodeId of ids) {
        expect(listed.get(nodeId)).toEqual(await repository.read(nodeId));
      }

      const selection = ids.slice(0, 2);
      const many = await repository.readMany(selection);
      expect([...many.keys()].sort()).toEqual(selection);
      for (const nodeId of selection) {
        expect(many.get(nodeId)).toEqual(listed.get(nodeId));
      }

      const delivered: NodeSnapshot[] = [];
      const streamed = await repository.stream((snapshot) => {
        delivered.push(snapshot);
      });
      expect(streamed).toEqual(listed);
      // Delivery order is unspecified, so compare as a set keyed by id.
      expect(
        new Map(
          delivered.map((snapshot) => [snapshot.record.nodeId, snapshot]),
        ),
      ).toEqual(listed);
      expect(delivered).toHaveLength(listed.size);
    });

    it('omits absent ids from readMany rather than failing', async () => {
      const { repository } = await open();
      const present = 'contract-partial-present';
      await putSuccessfully(repository, {
        nodeId: present,
        record: note(present, 'Contract partial', 'here'),
      });

      const many = await repository.readMany([
        present,
        'contract-partial-absent',
        // A repeated id is one node, not two reads with two answers.
        present,
      ]);

      expect([...many.keys()]).toEqual([present]);
      await expect(repository.readMany([])).resolves.toEqual(new Map());
    });

    it('reads an absent Space as an empty collection', async () => {
      const { missingRepository } = await open();

      await expect(missingRepository.list()).resolves.toEqual(new Map());
      await expect(
        missingRepository.readMany(['contract-missing-space-node']),
      ).resolves.toEqual(new Map());

      const delivered: NodeSnapshot[] = [];
      await expect(
        missingRepository.stream((snapshot) => delivered.push(snapshot)),
      ).resolves.toEqual(new Map());
      expect(delivered).toEqual([]);
    });

    it('stops delivering to an aborted stream', async () => {
      const { repository } = await open();
      const nodeId = 'contract-stream-abort';
      await putSuccessfully(repository, {
        nodeId,
        record: note(nodeId, 'Contract abort', 'body'),
      });

      const delivered: NodeSnapshot[] = [];
      // Already aborted, so no adapter has an excuse to deliver: this pins
      // that the promise still settles rather than that a mid-scan abort is
      // observed at any particular node.
      await repository.stream((snapshot) => delivered.push(snapshot), {
        signal: { aborted: true },
      });

      expect(delivered).toEqual([]);
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

    it('reports the adapter-defined result for a standalone put after deletion', async () => {
      const { repository, deletedNodePut } = await open();
      const nodeId = 'contract-late-put';
      const record = note(nodeId, 'Contract late put', 'before');
      await putSuccessfully(repository, { nodeId, record });
      await repository.delete(nodeId);

      const late = { ...record, content: 'late resurrection' };
      const result = await repository.put({ nodeId, record: late });
      if (deletedNodePut === 'write-suppressed') {
        expect(result).toEqual({ ok: false, reason: 'write-suppressed' });
        await expect(repository.read(nodeId)).resolves.toBeNull();
      } else {
        expect(result).toMatchObject({ ok: true, record: late });
        await expect(repository.read(nodeId)).resolves.toMatchObject({
          record: late,
        });
      }
    });

    describe('changes', () => {
      async function changedSince(
        repository: SpaceNodes,
        since: Awaited<ReturnType<SpaceNodes['changes']>>['position'],
      ): Promise<readonly string[]> {
        const { nodeIds } = await repository.changes(since);
        if (nodeIds === null)
          throw new Error('Expected a comparable change position');
        return nodeIds;
      }

      it('says nothing about what changed when no position is given', async () => {
        const { repository } = await open();
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A', 'a'),
        });

        const { position, nodeIds } = await repository.changes();
        expect(nodeIds).toBeNull();
        expect(position.epoch).toEqual(expect.any(String));
        expect(Number.isSafeInteger(position.seq)).toBe(true);
      });

      it('names every node put after the position was read', async () => {
        const { repository } = await open();
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A', 'a'),
        });
        const { position } = await repository.changes();

        // A new node, and an existing one whose title alone changes.
        await putSuccessfully(repository, {
          nodeId: 'contract-change-b',
          record: note('contract-change-b', 'Contract change B', 'b'),
        });
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A renamed', 'a'),
        });

        const changed = await changedSince(repository, position);
        expect(changed).toEqual(
          expect.arrayContaining(['contract-change-a', 'contract-change-b']),
        );
        expect(new Set(changed).size).toBe(changed.length);
      });

      it('keeps naming a later write from every earlier position', async () => {
        const { repository } = await open();
        const first = (await repository.changes()).position;
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A', 'a'),
        });
        const second = (await repository.changes()).position;
        await putSuccessfully(repository, {
          nodeId: 'contract-change-b',
          record: note('contract-change-b', 'Contract change B', 'b'),
        });

        expect(await changedSince(repository, first)).toEqual(
          expect.arrayContaining(['contract-change-a', 'contract-change-b']),
        );
        expect(await changedSince(repository, second)).toContain(
          'contract-change-b',
        );
        // Asking again changes nothing: reading is not consuming.
        expect(await changedSince(repository, second)).toContain(
          'contract-change-b',
        );
      });

      it('does not name a deleted node', async () => {
        const { repository } = await open();
        const { position } = await repository.changes();
        await putSuccessfully(repository, {
          nodeId: 'contract-change-gone',
          record: note('contract-change-gone', 'Contract change gone', 'x'),
        });
        await repository.delete('contract-change-gone');

        expect(await changedSince(repository, position)).not.toContain(
          'contract-change-gone',
        );
      });

      it('cannot compare a position from another sequence', async () => {
        const { repository } = await open();
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A', 'a'),
        });

        const { nodeIds } = await repository.changes({
          epoch: 'contract-some-other-sequence',
          seq: 0,
        });
        expect(nodeIds).toBeNull();
      });

      it('reports no node of a Space that does not exist', async () => {
        const { missingRepository } = await open();

        const first = await missingRepository.changes();
        expect(first.nodeIds).toBeNull();
        const again = await missingRepository.changes(first.position);
        expect(again.nodeIds ?? []).toEqual([]);
      });

      it('names a node put by a Space write', async () => {
        const { repository, space } = await open();
        if (!space) return;
        const { position } = await repository.changes();
        const record = await space.read();
        if (!record) throw new Error('Contract Space is missing');

        const written = await space.write({
          expectedVersion: record.version,
          nextRecord: { ...record, version: record.version + 1 },
          nodeMutations: [
            {
              kind: 'put',
              nodeId: 'contract-change-batch',
              record: note(
                'contract-change-batch',
                'Contract change batch',
                'written with the Space',
              ),
            },
          ],
        });
        expect(written.ok).toBe(true);

        expect(await changedSince(repository, position)).toContain(
          'contract-change-batch',
        );
      });

      it('answers from a position read before the store was reopened', async () => {
        const { repository, reopen } = await open();
        if (!reopen) return;
        await putSuccessfully(repository, {
          nodeId: 'contract-change-a',
          record: note('contract-change-a', 'Contract change A', 'a'),
        });
        const { position } = await repository.changes();
        await putSuccessfully(repository, {
          nodeId: 'contract-change-b',
          record: note('contract-change-b', 'Contract change B', 'b'),
        });

        const reopened = await reopen();
        expect(await changedSince(reopened, position)).toContain(
          'contract-change-b',
        );
        // And a write made after the restart is in the same sequence.
        const afterRestart = (await reopened.changes()).position;
        expect(afterRestart.epoch).toBe(position.epoch);
        await putSuccessfully(reopened, {
          nodeId: 'contract-change-c',
          record: note('contract-change-c', 'Contract change C', 'c'),
        });
        expect(await changedSince(reopened, position)).toEqual(
          expect.arrayContaining(['contract-change-b', 'contract-change-c']),
        );
        expect(await changedSince(reopened, afterRestart)).toContain(
          'contract-change-c',
        );
      });
    });
  });
}
