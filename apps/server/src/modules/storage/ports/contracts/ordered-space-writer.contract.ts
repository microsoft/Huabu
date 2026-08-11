// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable minimum contract for {@link OrderedSpaceWriter}.
 *
 * The suite proves business-result, forward-ordering, and continued-process
 * failure rollback for executor batches. Crash, power-loss, lost-connection,
 * multi-process, retry, and publication behavior cannot be established by
 * this in-process suite and are not portable claims.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type {
  CanvasDeltaRepository,
  NodeRepository,
  OrderedSpaceWriteInput,
  OrderedSpaceWriter,
  SpaceRepository,
} from '../structured.js';

export interface OrderedSpaceWriterContractScope {
  readonly writer: OrderedSpaceWriter;
  readonly record: SpaceRepository;
  readonly nodes: NodeRepository;
  readonly deltas: CanvasDeltaRepository;
}

export interface OrderedSpaceWriterContractHarness {
  /** Existing ordinary Space, initially at version 0 with `existingNode`. */
  readonly space: OrderedSpaceWriterContractScope;
  /** Independent writer for the same Space as `space`. */
  readonly concurrent: OrderedSpaceWriter;
  /** Scope whose Space record is absent. */
  readonly missing: OrderedSpaceWriterContractScope;
  readonly existingNode: NodeContent;
  /** Node id/name absent from all fixture Spaces. */
  readonly newNode: NodeContent;
  /**
   * Make the next delta append reject before it writes a row.
   *
   * The writer has already attempted nodes and record by this point.
   * Return a callback that removes the fault injection.
   */
  readonly failNextDeltaAppend: (
    error: Error,
  ) => Promise<() => void> | (() => void);
  readonly cleanup?: () => Promise<void> | void;
}

function nextRecord(
  current: CanvasFile,
  state: CanvasFile['state'],
): CanvasFile {
  return {
    ...current,
    version: current.version + 1,
    state,
    updatedAt: current.updatedAt + 1,
  };
}

function deltaFor(version: number, marker: string): DeltaLogEntry {
  return {
    version,
    ts: version + 100,
    commands: [{ contract: marker }],
    deltas: [{ contract: marker }],
    originator: { source: 'system' },
  };
}

async function requireRecord(repository: SpaceRepository): Promise<CanvasFile> {
  const record = await repository.read();
  if (record === null) throw new Error('Contract fixture Space is missing');
  return record;
}

function writeInput(
  current: CanvasFile,
  overrides: Partial<OrderedSpaceWriteInput> = {},
): OrderedSpaceWriteInput {
  return {
    expectedVersion: current.version,
    nextRecord: nextRecord(current, current.state),
    nodeMutations: [],
    ...overrides,
  };
}

export function describeOrderedSpaceWriterContract(
  name: string,
  createHarness: () =>
    | Promise<OrderedSpaceWriterContractHarness>
    | OrderedSpaceWriterContractHarness,
): void {
  describe(`OrderedSpaceWriter contract: ${name}`, () => {
    let harness: OrderedSpaceWriterContractHarness | null = null;

    async function open(): Promise<OrderedSpaceWriterContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('applies nodes, then the Space record, then one optional delta', async () => {
      const { space, existingNode, newNode } = await open();
      const current = await requireRecord(space.record);
      const next = nextRecord(current, {
        ...current.state,
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
      });
      const delta = deltaFor(next.version, 'success');

      await expect(
        space.writer.apply({
          expectedVersion: current.version,
          nextRecord: next,
          nodeMutations: [
            { kind: 'delete', nodeId: existingNode.nodeId },
            {
              kind: 'put',
              nodeId: newNode.nodeId,
              record: newNode,
              authoritativeInsert: true,
            },
          ],
          delta,
        }),
      ).resolves.toEqual({ ok: true });

      await expect(space.nodes.read(existingNode.nodeId)).resolves.toBeNull();
      await expect(space.nodes.read(newNode.nodeId)).resolves.toMatchObject({
        record: newNode,
      });
      await expect(space.record.read()).resolves.toEqual(next);
      await expect(space.deltas.readSince(current.version)).resolves.toEqual([
        delta,
      ]);
    });

    it('makes the Space version check a side-effect-free business outcome', async () => {
      const { space, newNode } = await open();
      const current = await requireRecord(space.record);

      await expect(
        space.writer.apply({
          expectedVersion: current.version + 10,
          nextRecord: {
            ...current,
            version: current.version + 11,
            updatedAt: current.updatedAt + 1,
          },
          nodeMutations: [
            { kind: 'put', nodeId: newNode.nodeId, record: newNode },
          ],
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version,
      });

      await expect(space.record.read()).resolves.toEqual(current);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(space.deltas.readSince(current.version)).resolves.toEqual(
        [],
      );
    });

    it('selects exactly one winner for concurrent same-baseline writes', async () => {
      const { space, concurrent } = await open();
      const current = await requireRecord(space.record);
      const first = writeInput(current, {
        nextRecord: nextRecord(current, {
          ...current.state,
          contractWinner: 'first',
        }),
      });
      const second = writeInput(current, {
        nextRecord: nextRecord(current, {
          ...current.state,
          contractWinner: 'second',
        }),
      });

      const results = await Promise.all([
        space.writer.apply(first),
        concurrent.apply(second),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: 'version-conflict',
          actualVersion: current.version + 1,
        },
      ]);
      expect((await requireRecord(space.record)).version).toBe(
        current.version + 1,
      );
    });

    it('reports a missing Space unless the record-only legacy create path is explicit', async () => {
      const { missing } = await open();
      const record: CanvasFile = {
        canvasId: missing.nodes.canvasId,
        title: 'Implicit contract Space',
        version: 1,
        state: { nodes: [], edges: [] },
        createdAt: 1,
        updatedAt: 1,
      };
      const input: OrderedSpaceWriteInput = {
        expectedVersion: 0,
        nextRecord: record,
        nodeMutations: [],
      };

      await expect(missing.writer.apply(input)).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
      await expect(missing.record.read()).resolves.toBeNull();

      await expect(
        missing.writer.apply({ ...input, allowCreate: true }),
      ).resolves.toEqual({ ok: true });
      // A backend may normalize an addressing-derived title while publishing
      // the record (Disk's legacy implicit-create path does). The stable id,
      // structural state, creation time, and requested version are portable.
      await expect(missing.record.read()).resolves.toMatchObject({
        canvasId: record.canvasId,
        version: record.version,
        state: record.state,
        createdAt: record.createdAt,
      });
    });

    it('rejects a delta whose version does not match the next record', async () => {
      const { space } = await open();
      const current = await requireRecord(space.record);
      const next = nextRecord(current, current.state);

      await expect(
        space.writer.apply(
          writeInput(current, {
            nextRecord: next,
            delta: deltaFor(next.version + 1, 'wrong-version'),
          }),
        ),
      ).rejects.toThrow();
      await expect(space.record.read()).resolves.toEqual(current);
      await expect(space.deltas.readSince(current.version)).resolves.toEqual(
        [],
      );
    });

    it('restores the node/record/delta prestate after a reported operational failure', async () => {
      const { space, newNode, failNextDeltaAppend } = await open();
      const current = await requireRecord(space.record);
      const next = nextRecord(current, {
        ...current.state,
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
      });
      const restoreFault = await failNextDeltaAppend(
        new Error('contract delta failure'),
      );

      try {
        await expect(
          space.writer.apply({
            expectedVersion: current.version,
            nextRecord: next,
            nodeMutations: [
              {
                kind: 'put',
                nodeId: newNode.nodeId,
                record: newNode,
                authoritativeInsert: true,
              },
            ],
            delta: deltaFor(next.version, 'operational-failure'),
          }),
        ).rejects.toThrow('contract delta failure');
      } finally {
        restoreFault();
      }

      await expect(space.record.read()).resolves.toEqual(current);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(space.deltas.readSince(current.version)).resolves.toEqual(
        [],
      );
    });
  });
}
