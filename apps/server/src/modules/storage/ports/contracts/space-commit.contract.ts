// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioral contract for aggregate Space commits. */

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type {
  SpaceCommitInput,
  SpaceCommitResult,
  SpaceHandle,
} from '../structured.js';

export interface SpaceCommitHarness {
  /** Handle for a seeded Space containing `existingNode`. */
  handle: SpaceHandle;
  /** Independent handle for the same seeded Space. */
  concurrent: SpaceHandle;
  /** Handle scoped to an absent Space. */
  missing: SpaceHandle;
  existingNode: NodeContent;
  newNode: NodeContent;
  /** Fixture-only write that does not advance the Space version. */
  replaceExistingNodeOutOfBand(record: NodeContent): Promise<void> | void;
  /**
   * Make the next publication append write its row and then fail. Returns a
   * restoration callback so the contract never leaves fault injection armed.
   */
  failNextPublicationAfterAppend(error: Error): () => void;
  cleanup?: () => Promise<void> | void;
}

type CommitOverrides = Partial<
  Pick<
    SpaceCommitInput,
    | 'expectedVersion'
    | 'record'
    | 'nodePreconditions'
    | 'nodeMutations'
    | 'publication'
    | 'forceVersionBump'
  >
>;

function inputFor(
  current: CanvasFile,
  overrides: CommitOverrides = {},
): SpaceCommitInput {
  return {
    expectedVersion: current.version,
    record: { title: current.title, state: current.state },
    nodePreconditions: [],
    nodeMutations: [],
    publication: {
      originator: { source: 'system' },
      optimistic: false,
      commands: [{ contract: 'command' }],
      structureDeltas: [{ contract: 'delta' }],
    },
    ...overrides,
  };
}

async function requireRecord(handle: SpaceHandle): Promise<CanvasFile> {
  const record = await handle.record.read();
  if (record === null) throw new Error('Contract fixture Space is missing');
  return record;
}

function requireSuccess(
  result: SpaceCommitResult,
): Extract<SpaceCommitResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected commit success, received ${result.reason}`);
  }
  return result;
}

export function describeSpaceCommitContract(
  name: string,
  createHarness: () => Promise<SpaceCommitHarness> | SpaceCommitHarness,
): void {
  describe(`SpaceCommit contract: ${name}`, () => {
    let harness: SpaceCommitHarness | null = null;

    async function open(): Promise<SpaceCommitHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('returns not-found for a missing Space', async () => {
      const { handle, missing } = await open();
      const current = await requireRecord(handle);

      await expect(missing.commit(inputFor(current))).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
    });

    it('lets exactly one same-baseline concurrent commit win', async () => {
      const { handle, concurrent } = await open();
      const current = await requireRecord(handle);
      const first = inputFor(current, {
        record: {
          title: current.title,
          state: { ...current.state, contractWinner: 'first' },
        },
      });
      const second = inputFor(current, {
        record: {
          title: current.title,
          state: { ...current.state, contractWinner: 'second' },
        },
      });

      const results = await Promise.all([
        handle.commit(first),
        concurrent.commit(second),
      ]);
      const winners = results.filter((result) => result.ok && result.committed);
      const losers = results.filter((result) => !result.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toEqual([
        expect.objectContaining({
          ok: false,
          reason: 'version-conflict',
          actualVersion: current.version + 1,
        }),
      ]);
      expect((await requireRecord(handle)).version).toBe(current.version + 1);
      expect(await handle.deltas.readSince(current.version)).toHaveLength(1);
    });

    it('requires exactly one precondition for every node mutation', async () => {
      const { handle, existingNode } = await open();
      const current = await requireRecord(handle);
      const snapshot = await handle.nodes.read(existingNode.nodeId);
      if (snapshot === null) throw new Error('Seed node is missing');
      const mutation = {
        kind: 'put' as const,
        record: { ...snapshot.record, content: 'Precondition probe' },
      };

      await expect(
        handle.commit(inputFor(current, { nodeMutations: [mutation] })),
      ).rejects.toThrow(/exactly one whole-record precondition/);
      await expect(
        handle.commit(
          inputFor(current, {
            nodePreconditions: [
              { nodeId: existingNode.nodeId, revision: snapshot.revision },
            ],
            nodeMutations: [],
          }),
        ),
      ).rejects.toThrow(/exactly one whole-record precondition/);

      expect((await requireRecord(handle)).version).toBe(current.version);
      expect(await handle.deltas.readSince(current.version)).toEqual([]);
    });

    it('rejects a node put absent from the proposed topology', async () => {
      const { handle, newNode } = await open();
      const current = await requireRecord(handle);

      const result = await handle.commit(
        inputFor(current, {
          nodePreconditions: [{ nodeId: newNode.nodeId, revision: null }],
          nodeMutations: [{ kind: 'put', record: newNode }],
        }),
      );

      expect(result).toEqual({
        ok: false,
        reason: 'node-topology-conflict',
        nodeId: newNode.nodeId,
        mutationType: newNode.type,
        topologyType: null,
      });
      expect((await requireRecord(handle)).version).toBe(current.version);
      await expect(handle.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(handle.deltas.readSince(current.version)).resolves.toEqual(
        [],
      );
    });

    it('rejects a node put whose type disagrees with proposed topology', async () => {
      const { handle, newNode } = await open();
      const current = await requireRecord(handle);
      const topologyType = newNode.type === 'note' ? 'text' : 'note';

      const result = await handle.commit(
        inputFor(current, {
          record: {
            title: current.title,
            state: {
              ...current.state,
              nodes: [
                ...(current.state.nodes ?? []),
                {
                  id: newNode.nodeId,
                  type: topologyType,
                  position: { x: 0, y: 0 },
                  data: {},
                },
              ],
            },
          },
          nodePreconditions: [{ nodeId: newNode.nodeId, revision: null }],
          nodeMutations: [{ kind: 'put', record: newNode }],
        }),
      );

      expect(result).toEqual({
        ok: false,
        reason: 'node-topology-conflict',
        nodeId: newNode.nodeId,
        mutationType: newNode.type,
        topologyType,
      });
      expect((await requireRecord(handle)).version).toBe(current.version);
      await expect(handle.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(handle.deltas.readSince(current.version)).resolves.toEqual(
        [],
      );
    });

    it('detects a whole-record node conflict before mutation', async () => {
      const { handle, existingNode, replaceExistingNodeOutOfBand } =
        await open();
      const current = await requireRecord(handle);
      const stale = await handle.nodes.read(existingNode.nodeId);
      if (stale === null) throw new Error('Seed node is missing');

      await replaceExistingNodeOutOfBand({
        ...stale.record,
        contractMetadata: { changed: true },
      });
      const result = await handle.commit(
        inputFor(current, {
          nodePreconditions: [
            { nodeId: existingNode.nodeId, revision: stale.revision },
          ],
          nodeMutations: [
            {
              kind: 'put',
              record: { ...stale.record, content: 'Stale attempted write' },
            },
          ],
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        reason: 'node-conflict',
        nodeId: existingNode.nodeId,
      });
      if (result.ok || result.reason !== 'node-conflict') {
        throw new Error('Expected node conflict');
      }
      expect(result.actualRevision).not.toBe(stale.revision);
      expect((await requireRecord(handle)).version).toBe(current.version);
      expect(await handle.deltas.readSince(current.version)).toEqual([]);
    });

    it('atomically puts and deletes node records with the Space record', async () => {
      const { handle, existingNode, newNode } = await open();
      const current = await requireRecord(handle);
      const existing = await handle.nodes.read(existingNode.nodeId);
      if (existing === null) throw new Error('Seed node is missing');
      const nextTopology = {
        id: newNode.nodeId,
        type: newNode.type,
        data: { label: newNode.label },
        position: { x: 50, y: 80 },
      };

      const result = requireSuccess(
        await handle.commit(
          inputFor(current, {
            record: {
              title: current.title,
              state: { ...current.state, nodes: [nextTopology] },
            },
            nodePreconditions: [
              { nodeId: existingNode.nodeId, revision: existing.revision },
              { nodeId: newNode.nodeId, revision: null },
            ],
            nodeMutations: [
              { kind: 'delete', nodeId: existingNode.nodeId },
              { kind: 'put', record: newNode },
            ],
          }),
        ),
      );

      expect(result.committed).toBe(true);
      expect(result.record.version).toBe(current.version + 1);
      expect(result.record.state.nodes).toEqual([nextTopology]);
      expect(await handle.nodes.read(existingNode.nodeId)).toBeNull();
      await expect(handle.nodes.read(newNode.nodeId)).resolves.toMatchObject({
        record: newNode,
      });
      expect(result.nodes.map((node) => node.record.nodeId)).toEqual([
        newNode.nodeId,
      ]);
      expect(result.event.nodeChanges).toEqual(
        expect.arrayContaining([
          { kind: 'delete', nodeId: existingNode.nodeId },
          expect.objectContaining({ kind: 'inline', nodeId: newNode.nodeId }),
        ]),
      );
    });

    it('advances the global version once and appends one publication row', async () => {
      const { handle } = await open();
      const current = await requireRecord(handle);
      const publication = {
        originator: { source: 'agent' as const, threadId: 'thread-contract' },
        optimistic: true,
        commands: [{ type: 'CONTRACT_COMMAND' }],
        structureDeltas: [{ kind: 'contract-delta' }],
        runId: 'run-contract',
      };
      const result = requireSuccess(
        await handle.commit(
          inputFor(current, {
            record: {
              title: current.title,
              state: { ...current.state, contractPublication: true },
            },
            publication,
          }),
        ),
      );

      expect(result.record.version).toBe(current.version + 1);
      expect(result.event).toMatchObject({
        fromVersion: current.version,
        toVersion: current.version + 1,
        originator: publication.originator,
        optimistic: true,
      });
      const rows = await handle.deltas.readSince(current.version);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: current.version + 1,
        runId: publication.runId,
        commands: publication.commands,
        deltas: publication.structureDeltas,
        commit: result.event,
      });
    });

    it('returns a semantic no-op without a version or publication', async () => {
      const { handle } = await open();
      const current = await requireRecord(handle);
      const result = requireSuccess(await handle.commit(inputFor(current)));

      expect(result).toMatchObject({
        committed: false,
        record: current,
        event: {
          fromVersion: current.version,
          toVersion: current.version,
          recordChanged: false,
          structureDeltas: [],
          nodeChanges: [],
        },
        nodes: [],
      });
      expect(await requireRecord(handle)).toEqual(current);
      expect(await handle.deltas.readSince(current.version)).toEqual([]);
    });

    it('supports the temporary forceVersionBump compatibility mode', async () => {
      const { handle } = await open();
      const current = await requireRecord(handle);
      const result = requireSuccess(
        await handle.commit(
          inputFor(current, {
            forceVersionBump: true,
            publication: {
              originator: { source: 'ui', tabId: 'tab-contract' },
              optimistic: true,
              commands: [],
              structureDeltas: [],
            },
          }),
        ),
      );

      expect(result).toMatchObject({
        committed: true,
        record: { version: current.version + 1 },
        event: {
          fromVersion: current.version,
          toVersion: current.version + 1,
          recordChanged: true,
        },
      });
      expect(await handle.deltas.readSince(current.version)).toHaveLength(1);
    });

    it('commits title and structure under one new structure revision', async () => {
      const { handle } = await open();
      const current = await requireRecord(handle);
      const baseline = requireSuccess(await handle.commit(inputFor(current)));
      const nextState = {
        ...current.state,
        nodes: current.state.nodes.map((node) => ({
          ...(node as Record<string, unknown>),
          position: { x: 90, y: 120 },
        })),
      };
      const result = requireSuccess(
        await handle.commit(
          inputFor(current, {
            record: { title: 'Renamed by contract', state: nextState },
          }),
        ),
      );

      expect(result.record).toMatchObject({
        title: 'Renamed by contract',
        state: nextState,
        version: current.version + 1,
      });
      expect(result.event.title).toBe('Renamed by contract');
      expect(result.event.structureRevision).not.toBe(
        baseline.event.structureRevision,
      );
      expect(result.event.toVersion).toBe(current.version + 1);

      const stale = await handle.commit(inputFor(current));
      expect(stale).toMatchObject({
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version + 1,
        structureRevision: result.event.structureRevision,
      });
    });

    it('inlines small node projections and invalidates records over 64 KiB', async () => {
      const { handle, newNode } = await open();
      const current = await requireRecord(handle);
      const large: NodeContent = {
        ...newNode,
        nodeId: 'node-contract-large',
        label: 'Large contract node',
        content: '界'.repeat(24 * 1024),
      };
      const topology = [newNode, large].map((node, index) => ({
        id: node.nodeId,
        type: node.type,
        data: { label: node.label },
        position: { x: index * 100, y: 0 },
      }));
      const result = requireSuccess(
        await handle.commit(
          inputFor(current, {
            record: {
              title: current.title,
              state: { ...current.state, nodes: topology },
            },
            nodePreconditions: [
              { nodeId: newNode.nodeId, revision: null },
              { nodeId: large.nodeId, revision: null },
            ],
            nodeMutations: [
              { kind: 'put', record: newNode },
              { kind: 'put', record: large },
            ],
          }),
        ),
      );

      expect(result.event.nodeChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'inline', nodeId: newNode.nodeId }),
          expect.objectContaining({ kind: 'invalidate', nodeId: large.nodeId }),
        ]),
      );
      const largeChange = result.event.nodeChanges.find(
        (change) => change.nodeId === large.nodeId,
      );
      expect(largeChange).not.toHaveProperty('projection');
    });

    it('rolls every aggregate write back when publication fails', async () => {
      const { handle, existingNode, failNextPublicationAfterAppend } =
        await open();
      const current = await requireRecord(handle);
      const beforeNode = await handle.nodes.read(existingNode.nodeId);
      if (beforeNode === null) throw new Error('Seed node is missing');
      const restorePublication = failNextPublicationAfterAppend(
        new Error('contract publication failure'),
      );

      try {
        await expect(
          handle.commit(
            inputFor(current, {
              record: {
                title: 'Must roll back title',
                state: { ...current.state, contractFailure: true },
              },
              nodePreconditions: [
                {
                  nodeId: existingNode.nodeId,
                  revision: beforeNode.revision,
                },
              ],
              nodeMutations: [
                {
                  kind: 'put',
                  record: {
                    ...beforeNode.record,
                    content: 'Must be rolled back',
                  },
                },
              ],
            }),
          ),
        ).rejects.toThrow('contract publication failure');
      } finally {
        restorePublication();
      }

      expect(await requireRecord(handle)).toEqual(current);
      await expect(handle.nodes.read(existingNode.nodeId)).resolves.toEqual(
        beforeNode,
      );
      expect(await handle.deltas.readSince(current.version)).toEqual([]);
    });
  });
}
