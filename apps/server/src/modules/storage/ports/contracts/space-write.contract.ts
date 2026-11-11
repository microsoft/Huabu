// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable minimum contract for {@link SpaceHandle.write}.
 *
 * The suite proves business-result, forward-ordering, and continued-process
 * failure rollback for executor batches. Crash, power-loss, lost-connection,
 * multi-process, retry, and publication behavior cannot be established by
 * this in-process suite and are not portable claims.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SaveIdReusedError } from '../save.js';

import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { SaveResult } from '../save.js';
import type { SpaceHandle, SpaceWriteInput } from '../structured.js';

export interface SpaceWriteContractHarness {
  /** Existing ordinary Space, initially at version 0 with `existingNode`. */
  readonly space: SpaceHandle;
  /** An independent handle for the same Space as `space`. */
  readonly concurrent: SpaceHandle;
  /** Handle whose Space record is absent. */
  readonly missing: SpaceHandle;
  readonly existingNode: NodeContent;
  /** Node id/name absent from all fixture Spaces. */
  readonly newNode: NodeContent;
  /**
   * Read back whatever the backend journaled for `space`, oldest first.
   *
   * A verification hook rather than a port member: the journal is written as
   * part of a write and never read by the application, so proving the append
   * landed is the harness's job, not something `SpaceHandle` should expose.
   */
  readonly readJournal: () => Promise<DeltaLogEntry[]>;
  /**
   * Make the next journal append reject before it writes a row.
   *
   * The write has already attempted nodes and record by this point.
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

const OPERATION_A = '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11';
const OPERATION_B = '5e2a9d17-3c44-4b8e-8a90-7d1c2b3e4f52';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function resultFor(
  operationId: string,
  digest: string,
  response: unknown,
  principalId = 'contract-principal',
): SaveResult {
  return { key: { principalId, operationId }, digest, response };
}

async function requireRecord(space: SpaceHandle): Promise<CanvasFile> {
  const record = await space.read();
  if (record === null) throw new Error('Contract fixture Space is missing');
  return record;
}

function writeInput(
  current: CanvasFile,
  overrides: Partial<SpaceWriteInput> = {},
): SpaceWriteInput {
  return {
    expectedVersion: current.version,
    nextRecord: nextRecord(current, current.state),
    nodeMutations: [],
    ...overrides,
  };
}

export function describeSpaceWriteContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceWriteContractHarness>
    | SpaceWriteContractHarness,
): void {
  describe(`SpaceHandle.write contract: ${name}`, () => {
    let harness: SpaceWriteContractHarness | null = null;

    async function open(): Promise<SpaceWriteContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('applies nodes, then the Space record, then one optional delta', async () => {
      const { space, existingNode, newNode, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, {
        ...current.state,
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
      });
      const delta = deltaFor(next.version, 'success');

      await expect(
        space.write({
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
      await expect(space.read()).resolves.toEqual(next);
      await expect(readJournal()).resolves.toEqual([delta]);
    });

    it('makes the Space version check a side-effect-free business outcome', async () => {
      const { space, newNode, readJournal } = await open();
      const current = await requireRecord(space);

      await expect(
        space.write({
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

      await expect(space.read()).resolves.toEqual(current);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(readJournal()).resolves.toEqual([]);
    });

    it('selects exactly one winner for concurrent same-baseline writes', async () => {
      const { space, concurrent } = await open();
      const current = await requireRecord(space);
      // Both writers read the same baseline and are issued with **no
      // intervening await**. This is the arrangement that actually
      // discriminates: an adapter whose version check and write run to
      // completion in one turn serializes them, while one that `await`s in
      // between lets the second writer observe the stale version so both
      // "succeed" — a lost update. Yielding before the second call instead
      // would make this sequential and vacuous, because the second writer
      // would simply read the already-updated record.
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
        space.write(first),
        concurrent.write(second),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: 'version-conflict',
          actualVersion: current.version + 1,
        },
      ]);
      expect((await requireRecord(space)).version).toBe(current.version + 1);
    });

    it('refuses a next version that is not expectedVersion + 1', async () => {
      const { space } = await open();
      const current = await requireRecord(space);

      for (const version of [current.version, current.version + 2]) {
        await expect(
          space.write({
            expectedVersion: current.version,
            nextRecord: { ...current, version },
            nodeMutations: [],
          }),
        ).rejects.toThrow();
      }
      await expect(space.read()).resolves.toEqual(current);
    });

    it('refuses a next record addressed at another Space', async () => {
      const { space } = await open();
      const current = await requireRecord(space);

      await expect(
        space.write(
          writeInput(current, {
            nextRecord: {
              ...nextRecord(current, current.state),
              canvasId: 'someone-else',
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(space.read()).resolves.toEqual(current);
    });

    it('refuses to change the identity fields through the batch', async () => {
      const { space } = await open();
      const current = await requireRecord(space);

      // Title addressing is an explicit collection operation, and creation
      // time is not a writer's to move. Both must reject rather than partially
      // apply — a batch that renamed as a side effect would leave the record
      // and the backend's own addressing disagreeing.
      await expect(
        space.write(
          writeInput(current, {
            nextRecord: {
              ...nextRecord(current, current.state),
              title: 'renamed through the record path',
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        space.write(
          writeInput(current, {
            nextRecord: {
              ...nextRecord(current, current.state),
              createdAt: current.createdAt + 1000,
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(space.read()).resolves.toEqual(current);
    });

    it('reports a missing Space unless the record-only legacy create path is explicit', async () => {
      const { missing } = await open();
      const record: CanvasFile = {
        canvasId: missing.canvasId,
        title: 'Implicit contract Space',
        version: 1,
        state: { nodes: [], edges: [] },
        createdAt: 1,
        updatedAt: 1,
      };
      const input: SpaceWriteInput = {
        expectedVersion: 0,
        nextRecord: record,
        nodeMutations: [],
      };

      await expect(missing.write(input)).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
      await expect(missing.read()).resolves.toBeNull();

      await expect(
        missing.write({ ...input, allowCreate: true }),
      ).resolves.toEqual({ ok: true });
      // A backend may normalize an addressing-derived title while publishing
      // the record (Disk's legacy implicit-create path does). The stable id,
      // structural state, creation time, and requested version are portable.
      await expect(missing.read()).resolves.toMatchObject({
        canvasId: record.canvasId,
        version: record.version,
        state: record.state,
        createdAt: record.createdAt,
      });
    });

    it('rejects a delta whose version does not match the next record', async () => {
      const { space, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, current.state);

      await expect(
        space.write(
          writeInput(current, {
            nextRecord: next,
            delta: deltaFor(next.version + 1, 'wrong-version'),
          }),
        ),
      ).rejects.toThrow();
      await expect(space.read()).resolves.toEqual(current);
      await expect(readJournal()).resolves.toEqual([]);
    });

    it('restores the node/record/delta prestate after a reported operational failure', async () => {
      const { space, newNode, failNextDeltaAppend, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, {
        ...current.state,
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
      });
      const restoreFault = await failNextDeltaAppend(
        new Error('contract delta failure'),
      );

      try {
        await expect(
          space.write({
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

      await expect(space.read()).resolves.toEqual(current);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(readJournal()).resolves.toEqual([]);
    });

    // ─── Result records ────────────────────────────────────────────────────

    it('stores the result record in the same write and returns it on lookup', async () => {
      const { space, concurrent, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, current.state);
      const response = { ok: true, nodeIds: ['generated-1'], nested: { n: 1 } };
      const result = resultFor(OPERATION_A, DIGEST_A, response);

      await expect(space.save.lookup(result.key)).resolves.toBeNull();
      await expect(
        space.write(
          writeInput(current, {
            nextRecord: next,
            delta: deltaFor(next.version, 'with-result'),
            result,
          }),
        ),
      ).resolves.toEqual({ ok: true });

      const stored = { digest: DIGEST_A, response, atVersion: next.version };
      await expect(space.save.lookup(result.key)).resolves.toEqual(stored);
      // Any handle for the Space answers, and the id compares like a UUID.
      await expect(
        concurrent.save.lookup({
          principalId: result.key.principalId,
          operationId: OPERATION_A.toUpperCase(),
        }),
      ).resolves.toEqual(stored);
      // Scoped to who asked: another principal's identical id is not this one.
      await expect(
        space.save.lookup({
          principalId: 'someone-else',
          operationId: OPERATION_A,
        }),
      ).resolves.toBeNull();
      await expect(
        space.save.lookup(resultFor(OPERATION_B, DIGEST_A, 0).key),
      ).resolves.toBeNull();
      await expect(readJournal()).resolves.toHaveLength(1);
    });

    it('answers a repeated request with the stored result and writes nothing', async () => {
      const { space, concurrent, newNode, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, current.state);
      const result = resultFor(OPERATION_A, DIGEST_A, { first: true });
      const input = writeInput(current, {
        nextRecord: next,
        delta: deltaFor(next.version, 'first'),
        result,
      });
      await expect(space.write(input)).resolves.toEqual({ ok: true });
      const stored = {
        digest: DIGEST_A,
        response: { first: true },
        atVersion: next.version,
      };

      // The retry a lost reply produces: same request, now-stale version. It
      // must be answered rather than refused as a version conflict.
      await expect(concurrent.write(input)).resolves.toEqual({
        ok: false,
        reason: 'result-exists',
        stored,
      });

      // And the same id recomputed against the new head must not apply again,
      // whatever it now carries.
      const after = await requireRecord(space);
      await expect(
        space.write({
          expectedVersion: after.version,
          nextRecord: nextRecord(after, {
            ...after.state,
            nodes: [{ id: newNode.nodeId, type: newNode.type }],
          }),
          nodeMutations: [
            { kind: 'put', nodeId: newNode.nodeId, record: newNode },
          ],
          delta: deltaFor(after.version + 1, 'second'),
          result: { ...result, response: { first: false } },
        }),
      ).resolves.toEqual({ ok: false, reason: 'result-exists', stored });

      await expect(space.read()).resolves.toEqual(next);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(readJournal()).resolves.toHaveLength(1);
      await expect(space.save.lookup(result.key)).resolves.toEqual(stored);
    });

    it('rejects a request id reused with a different digest', async () => {
      const { space, readJournal } = await open();
      const current = await requireRecord(space);
      const next = nextRecord(current, current.state);
      const result = resultFor(OPERATION_A, DIGEST_A, { first: true });
      await space.write(writeInput(current, { nextRecord: next, result }));

      await expect(
        space.write({
          expectedVersion: next.version,
          nextRecord: nextRecord(next, { ...next.state, reused: true }),
          nodeMutations: [],
          delta: deltaFor(next.version + 1, 'reused'),
          result: resultFor(OPERATION_A, DIGEST_B, { other: true }),
        }),
      ).rejects.toBeInstanceOf(SaveIdReusedError);
      await expect(
        space.save.record({
          expectedVersion: next.version,
          result: resultFor(OPERATION_A, DIGEST_B, { other: true }),
        }),
      ).rejects.toBeInstanceOf(SaveIdReusedError);

      await expect(space.read()).resolves.toEqual(next);
      await expect(readJournal()).resolves.toEqual([]);
      await expect(space.save.lookup(result.key)).resolves.toMatchObject({
        digest: DIGEST_A,
        response: { first: true },
      });
    });

    it('stores no result record when the write is a business refusal or fails', async () => {
      const { space, missing, newNode, failNextDeltaAppend, readJournal } =
        await open();
      const current = await requireRecord(space);
      const result = resultFor(OPERATION_A, DIGEST_A, { ok: true });

      await expect(
        space.write({
          expectedVersion: current.version + 5,
          nextRecord: { ...current, version: current.version + 6 },
          nodeMutations: [],
          result,
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'version-conflict' });
      await expect(space.save.lookup(result.key)).resolves.toBeNull();

      await expect(
        missing.write({
          expectedVersion: 0,
          nextRecord: {
            canvasId: missing.canvasId,
            title: 'Missing',
            version: 1,
            state: { nodes: [], edges: [] },
            createdAt: 1,
            updatedAt: 1,
          },
          nodeMutations: [],
          result,
        }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
      await expect(missing.save.lookup(result.key)).resolves.toBeNull();

      const next = nextRecord(current, {
        ...current.state,
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
      });
      const input: SpaceWriteInput = {
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
        delta: deltaFor(next.version, 'failing-with-result'),
        result,
      };
      const restoreFault = await failNextDeltaAppend(
        new Error('contract delta failure'),
      );
      try {
        await expect(space.write(input)).rejects.toThrow(
          'contract delta failure',
        );
      } finally {
        await restoreFault();
      }
      await expect(space.read()).resolves.toEqual(current);
      await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
      await expect(readJournal()).resolves.toEqual([]);
      await expect(space.save.lookup(result.key)).resolves.toBeNull();

      // Nothing of the failure lingers: the same request then simply applies.
      await expect(space.write(input)).resolves.toEqual({ ok: true });
      await expect(space.read()).resolves.toEqual(next);
      await expect(space.save.lookup(result.key)).resolves.toEqual({
        digest: DIGEST_A,
        response: { ok: true },
        atVersion: next.version,
      });
    });

    it('refuses a malformed result record before writing anything', async () => {
      const { space, missing } = await open();
      const current = await requireRecord(space);
      const good = resultFor(OPERATION_A, DIGEST_A, { ok: true });
      const malformed: SaveResult[] = [
        { ...good, digest: 'not-a-digest' },
        { ...good, digest: DIGEST_A.toUpperCase() },
        { ...good, key: { ...good.key, operationId: 'not-a-uuid' } },
        { ...good, key: { ...good.key, principalId: '' } },
        { ...good, response: undefined },
        { ...good, response: { bad: Number.NaN } },
        { ...good, response: 'x'.repeat(4 * 1024 * 1024 + 1) },
      ];
      for (const result of malformed) {
        await expect(
          space.write(writeInput(current, { result })),
        ).rejects.toThrow();
        await expect(
          space.save.record({ expectedVersion: current.version, result }),
        ).rejects.toThrow();
      }
      await expect(
        missing.write({
          expectedVersion: 0,
          nextRecord: {
            canvasId: missing.canvasId,
            title: 'Implicit',
            version: 1,
            state: { nodes: [], edges: [] },
            createdAt: 1,
            updatedAt: 1,
          },
          nodeMutations: [],
          allowCreate: true,
          result: good,
        }),
      ).rejects.toThrow();
      await expect(missing.read()).resolves.toBeNull();
      await expect(space.read()).resolves.toEqual(current);
      await expect(space.save.lookup(good.key)).resolves.toBeNull();
    });

    it('records an outcome that changed nothing without moving the version', async () => {
      const { space, concurrent, missing, readJournal } = await open();
      const current = await requireRecord(space);
      const result = resultFor(OPERATION_A, DIGEST_A, { applied: 0 });

      await expect(
        space.save.record({ expectedVersion: current.version + 1, result }),
      ).resolves.toEqual({
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version,
      });
      await expect(space.save.lookup(result.key)).resolves.toBeNull();

      await expect(
        space.save.record({ expectedVersion: current.version, result }),
      ).resolves.toEqual({ ok: true });
      const stored = {
        digest: DIGEST_A,
        response: { applied: 0 },
        atVersion: current.version,
      };
      await expect(concurrent.save.lookup(result.key)).resolves.toEqual(stored);
      await expect(
        concurrent.save.record({ expectedVersion: current.version, result }),
      ).resolves.toEqual({ ok: false, reason: 'result-exists', stored });
      // A later write quoting the same id is the same request, already answered.
      await expect(
        space.write(writeInput(current, { result })),
      ).resolves.toEqual({ ok: false, reason: 'result-exists', stored });

      await expect(space.read()).resolves.toEqual(current);
      await expect(readJournal()).resolves.toEqual([]);
      await expect(
        missing.save.record({ expectedVersion: 0, result }),
      ).rejects.toThrow();
    });

    // ─── Version stamps ────────────────────────────────────────────────────

    it('creates the stamp baseline lazily, at the head of the first call', async () => {
      const { space, concurrent, missing } = await open();
      await expect(missing.save.stamps()).resolves.toBeNull();
      await expect(missing.read()).resolves.toBeNull();

      // Writes before anyone asked leave nothing behind to be at an old floor.
      const start = await requireRecord(space);
      const one = nextRecord(start, {
        ...start.state,
        nodes: [{ id: 'early', type: 'note' }],
      });
      await space.write(writeInput(start, { nextRecord: one }));

      const first = await space.save.stamps();
      expect(first).toEqual({
        lineage: expect.stringMatching(/^[0-9a-f-]{36}$/),
        floor: one.version,
        version: one.version,
        nodes: {},
      });
      // Idempotent, and the same answer through any handle.
      await expect(space.save.stamps()).resolves.toEqual(first);
      await expect(concurrent.save.stamps()).resolves.toEqual(first);
      await expect(space.read()).resolves.toEqual(one);
    });

    it('advances stamps sparsely on create, reparent and delete', async () => {
      const { space, newNode } = await open();
      const start = await requireRecord(space);
      const seeded = nextRecord(start, {
        ...start.state,
        nodes: [
          { id: 'frame-a', type: 'frame' },
          { id: 'frame-b', type: 'frame' },
          { id: 'child', type: 'note', parentId: 'frame-a' },
        ],
      });
      await space.write(writeInput(start, { nextRecord: seeded }));
      const baseline = await space.save.stamps();
      if (!baseline) throw new Error('Contract fixture Space is missing');
      const floor = seeded.version;
      expect(baseline).toMatchObject({ floor, version: floor, nodes: {} });

      // Create: only the new id is stamped.
      const created = nextRecord(seeded, {
        ...seeded.state,
        nodes: [
          ...seeded.state.nodes,
          { id: newNode.nodeId, type: newNode.type, parentId: 'frame-a' },
        ],
      });
      await space.write({
        expectedVersion: seeded.version,
        nextRecord: created,
        nodeMutations: [
          {
            kind: 'put',
            nodeId: newNode.nodeId,
            record: newNode,
            authoritativeInsert: true,
          },
        ],
        delta: deltaFor(created.version, 'create'),
      });
      await expect(space.save.stamps()).resolves.toEqual({
        ...baseline,
        version: created.version,
        nodes: {
          [newNode.nodeId]: {
            created: created.version,
            membership: created.version,
          },
        },
      });

      // A write that moves nothing in the topology moves only the version.
      const touched = nextRecord(created, {
        ...created.state,
        nodes: created.state.nodes.map((node) => ({
          ...(node as object),
          position: { x: 1, y: 2 },
        })),
      });
      await space.write(writeInput(created, { nextRecord: touched }));
      await expect(space.save.stamps()).resolves.toMatchObject({
        version: touched.version,
        nodes: {
          [newNode.nodeId]: {
            created: created.version,
            membership: created.version,
          },
        },
      });

      // Reparent: a pre-baseline node keeps `created = floor`; a stamped one
      // keeps its own. Detaching (no parent) is a membership change too.
      const reparented = nextRecord(touched, {
        ...touched.state,
        nodes: [
          { id: 'frame-a', type: 'frame' },
          { id: 'frame-b', type: 'frame' },
          { id: 'child', type: 'note', parentId: 'frame-b' },
          { id: newNode.nodeId, type: newNode.type },
        ],
      });
      await space.write({
        ...writeInput(touched, { nextRecord: reparented }),
        delta: deltaFor(reparented.version, 'reparent'),
      });
      await expect(space.save.stamps()).resolves.toEqual({
        ...baseline,
        version: reparented.version,
        nodes: {
          child: { created: floor, membership: reparented.version },
          [newNode.nodeId]: {
            created: created.version,
            membership: reparented.version,
          },
        },
      });

      // Delete: the stamp goes with the node, and the same id created again
      // is a new node.
      const deleted = nextRecord(reparented, {
        ...reparented.state,
        nodes: reparented.state.nodes.filter(
          (node) => (node as { id: string }).id !== 'child',
        ),
      });
      await space.write({
        ...writeInput(reparented, { nextRecord: deleted }),
        delta: deltaFor(deleted.version, 'delete'),
      });
      expect((await space.save.stamps())?.nodes).toEqual({
        [newNode.nodeId]: {
          created: created.version,
          membership: reparented.version,
        },
      });
      const recreated = nextRecord(deleted, {
        ...deleted.state,
        nodes: [
          ...deleted.state.nodes,
          { id: 'child', type: 'note', parentId: 'frame-b' },
        ],
      });
      await space.write(writeInput(deleted, { nextRecord: recreated }));
      await expect(space.save.stamps()).resolves.toEqual({
        ...baseline,
        version: recreated.version,
        nodes: {
          child: { created: recreated.version, membership: recreated.version },
          [newNode.nodeId]: {
            created: created.version,
            membership: reparented.version,
          },
        },
      });
    });

    it('advances stamps for a record-only write that carries no node batch', async () => {
      const { space, concurrent } = await open();
      const start = await requireRecord(space);
      const baseline = await space.save.stamps();
      if (!baseline) throw new Error('Contract fixture Space is missing');

      // The browser's structural PUT: a whole next record, `nodeMutations: []`
      // and no delta. It is a topology writer like any other.
      const put = nextRecord(start, {
        ...start.state,
        nodes: [
          { id: 'put-frame', type: 'frame' },
          { id: 'put-note', type: 'note', parentId: 'put-frame' },
        ],
      });
      await expect(
        concurrent.write({
          expectedVersion: start.version,
          nextRecord: put,
          nodeMutations: [],
        }),
      ).resolves.toEqual({ ok: true });
      await expect(space.save.stamps()).resolves.toEqual({
        ...baseline,
        version: put.version,
        nodes: {
          'put-frame': { created: put.version, membership: put.version },
          'put-note': { created: put.version, membership: put.version },
        },
      });

      // Stamps and a result record land with the same write.
      const moved = nextRecord(put, {
        ...put.state,
        nodes: [
          { id: 'put-frame', type: 'frame' },
          { id: 'put-note', type: 'note' },
        ],
      });
      const result = resultFor(OPERATION_B, DIGEST_B, { moved: true });
      await expect(
        space.write({
          expectedVersion: put.version,
          nextRecord: moved,
          nodeMutations: [],
          result,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(space.save.stamps()).resolves.toMatchObject({
        version: moved.version,
        nodes: {
          'put-note': { created: put.version, membership: moved.version },
        },
      });
      await expect(space.save.lookup(result.key)).resolves.toMatchObject({
        atVersion: moved.version,
      });

      // A refused or repeated write advances nothing.
      const before = await space.save.stamps();
      await space.write({
        expectedVersion: put.version,
        nextRecord: moved,
        nodeMutations: [],
        result,
      });
      await space.write({
        expectedVersion: start.version,
        nextRecord: put,
        nodeMutations: [],
      });
      await expect(space.save.stamps()).resolves.toEqual(before);
    });
  });
}
