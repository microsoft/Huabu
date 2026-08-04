/**
 * Reusable contract for {@link CanvasLogRepository}.
 *
 * ⚠️ **Adapter-local guarantees.** As with the Space-record suite, the
 * linearizability properties asserted here belong to the adapter under test,
 * not to the running application: the compatibility facade is still a second
 * mutation entry point (docs/proposals/multi-backend-storage.md §12.2.3). A
 * green run is evidence about this adapter, not about single write authority.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@sediment/shared/canvas-engine';

import type { DeltaLogEntry } from '../../../canvas/persistence-types.js';
import type { CanvasLogRepository } from '../structured.js';
import type { IntentEpisode, RecentAction } from '@sediment/shared';
import type {
  CanvasChangeRecord,
  CanvasNode,
} from '@sediment/shared/canvas-engine';

export interface CanvasLogRepositoryHarness {
  logs: CanvasLogRepository;
  /**
   * A second repository handle for the same Space, so concurrency cases use
   * genuinely independent objects rather than one instance called twice.
   */
  concurrent: CanvasLogRepository;
  cleanup?: () => Promise<void> | void;
}


function action(nodeId: string): RecentAction {
  return {
    action: 'node_selected',
    node: { id: nodeId, type: 'note', label: nodeId },
  };
}

/** The nodeId a fixture event carries, for order assertions. */
function actionNodeId(payload: RecentAction): string {
  return (payload as Extract<RecentAction, { action: 'node_selected' }>).node.id;
}

function delta(version: number): DeltaLogEntry {
  return {
    version,
    ts: 1_000 + version,
    commands: [],
    deltas: [],
    originator: { source: 'agent' },
  };
}

function node(id: string, content: string): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { label: id, content },
  } as CanvasNode;
}

/**
 * A real change record for `nodeId`.
 *
 * Built through the engine rather than hand-rolled: `coalesceChanges` groups
 * by the forward delta reconstructed from `revertDeltas`, so a fabricated
 * record with an empty `revertDeltas` is silently dropped and the suite would
 * assert nothing.
 */
function change(nodeId: string, content = 'body'): CanvasChangeRecord {
  const [record] = extractCanvasChanges([
    { type: 'INSERT_NODE', node: node(nodeId, content) },
  ]);
  return record;
}

function episode(id: string, chosenLabel: string): IntentEpisode {
  return {
    id,
    timestamp: 1,
    contextSummary: `ctx-${id}`,
    candidates: [],
    outcome: { type: 'selected', chosenIndex: 0, chosenLabel },
  };
}

export function describeCanvasLogRepositoryContract(
  name: string,
  createHarness: () =>
    | Promise<CanvasLogRepositoryHarness>
    | CanvasLogRepositoryHarness,
): void {
  describe(`CanvasLogRepository contract (adapter-local): ${name}`, () => {
    let harness: CanvasLogRepositoryHarness | null = null;

    async function open(): Promise<CanvasLogRepositoryHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    // ── Events ──────────────────────────────────────────────────────────────

    it('reads an empty event log as an empty list', async () => {
      const { logs } = await open();
      await expect(logs.readEvents()).resolves.toEqual([]);
    });

    it('ignores an empty append', async () => {
      const { logs } = await open();
      await logs.appendEvents([]);
      await expect(logs.readEvents()).resolves.toEqual([]);
    });

    it('preserves append order across batches', async () => {
      const { logs } = await open();
      await logs.appendEvents([
        { payload: action('a'), ts: 1 },
        { payload: action('b'), ts: 2 },
      ]);
      await logs.appendEvents([{ payload: action('c'), ts: 3 }]);

      const events = await logs.readEvents();
      expect(events.map((e) => e.ts)).toEqual([1, 2, 3]);
    });

    it('defaults a missing timestamp to server time', async () => {
      const { logs } = await open();
      const before = Date.now();
      await logs.appendEvents([{ payload: action('a') }]);

      const [event] = await logs.readEvents();
      expect(event.ts).toBeGreaterThanOrEqual(before);
    });

    it('returns the most recent records when limited', async () => {
      const { logs } = await open();
      await logs.appendEvents(
        [1, 2, 3, 4, 5].map((ts) => ({ payload: action(`n${ts}`), ts })),
      );

      const tail = await logs.readEvents(2);
      expect(tail.map((e) => e.ts)).toEqual([4, 5]);
    });

    it('keeps one batch contiguous under a concurrent append', async () => {
      const { logs, concurrent } = await open();
      await Promise.all([
        logs.appendEvents([
          { payload: action('a1'), ts: 1 },
          { payload: action('a2'), ts: 2 },
          { payload: action('a3'), ts: 3 },
        ]),
        concurrent.appendEvents([
          { payload: action('b1'), ts: 4 },
          { payload: action('b2'), ts: 5 },
        ]),
      ]);

      const events = await logs.readEvents();
      expect(events).toHaveLength(5);
      // Neither batch is split by the other: each appears as one run.
      const ids = events.map((e) => actionNodeId(e.payload)).join(',');
      expect(ids).toContain('a1,a2,a3');
      expect(ids).toContain('b1,b2');
    });

    // ── Delta log ───────────────────────────────────────────────────────────

    it('reads an empty delta log as an empty list', async () => {
      const { logs } = await open();
      await expect(logs.readDeltasSince(0)).resolves.toEqual([]);
    });

    it('filters deltas strictly greater than the requested version', async () => {
      const { logs } = await open();
      await logs.appendDelta(delta(1));
      await logs.appendDelta(delta(2));
      await logs.appendDelta(delta(3));

      expect((await logs.readDeltasSince(0)).map((d) => d.version)).toEqual([
        1, 2, 3,
      ]);
      expect((await logs.readDeltasSince(2)).map((d) => d.version)).toEqual([3]);
      expect(await logs.readDeltasSince(3)).toEqual([]);
    });

    it('rejects a duplicate or out-of-order delta version', async () => {
      const { logs } = await open();
      await logs.appendDelta(delta(1));
      await logs.appendDelta(delta(5));

      await expect(logs.appendDelta(delta(5))).rejects.toThrow();
      await expect(logs.appendDelta(delta(2))).rejects.toThrow();

      // The rejected appends left nothing behind.
      expect((await logs.readDeltasSince(0)).map((d) => d.version)).toEqual([
        1, 5,
      ]);
    });

    it('lets exactly one of two deltas racing from one tick claim a version', async () => {
      const { logs, concurrent } = await open();
      await logs.appendDelta(delta(1));

      // Issued from one tick, with no intervening await: an adapter that
      // `await`s between its tail read and its append lets both observe
      // version 1 as the head and both write version 2. See the same note on
      // the SpaceRepository suite's race case.
      const results = await Promise.allSettled([
        logs.appendDelta(delta(2)),
        concurrent.appendDelta(delta(2)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect((await logs.readDeltasSince(0)).map((d) => d.version)).toEqual([
        1, 2,
      ]);
    });

    // ── Change-review records ───────────────────────────────────────────────

    it('reads an unknown thread as an empty list', async () => {
      const { logs } = await open();
      await expect(logs.readChanges('thread-x')).resolves.toEqual([]);
    });

    it('coalesces changes for the same entity', async () => {
      const { logs } = await open();
      const merged = await logs.appendChanges('t1', [
        change('node-a', 'first'),
        change('node-a', 'second'),
        change('node-b', 'other'),
      ]);

      expect(merged.map((r) => r.nodeId).sort()).toEqual(['node-a', 'node-b']);
      // What `appendChanges` returns is what a later read observes.
      expect(await logs.readChanges('t1')).toEqual(merged);
    });

    it('scopes changes by thread', async () => {
      const { logs } = await open();
      await logs.appendChanges('t1', [change('node-a')]);
      await logs.appendChanges('t2', [change('node-b')]);

      expect((await logs.readChanges('t1')).map((r) => r.nodeId)).toEqual([
        'node-a',
      ]);
      expect((await logs.readChanges('t2')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);
    });

    it('removes one record by id and reports a miss as null', async () => {
      const { logs } = await open();
      const stored = await logs.appendChanges('t1', [
        change('node-a'),
        change('node-b'),
      ]);
      const target = stored.find((r) => r.nodeId === 'node-a')!;

      const removed = await logs.removeChange('t1', target.id);
      expect(removed?.id).toBe(target.id);
      expect((await logs.readChanges('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);

      await expect(logs.removeChange('t1', target.id)).resolves.toBeNull();
    });

    it('does not lose a record when two agents append concurrently', async () => {
      const { logs, concurrent } = await open();
      // From one tick: a read → merge → write that is not one turn would let
      // the second append overwrite the first's record instead of merging it.
      await Promise.all([
        logs.appendChanges('t1', [change('node-a')]),
        concurrent.appendChanges('t1', [change('node-b')]),
      ]);

      expect((await logs.readChanges('t1')).map((r) => r.nodeId).sort()).toEqual(
        ['node-a', 'node-b'],
      );
    });

    it('does not lose a record when an append races a removal', async () => {
      const { logs, concurrent } = await open();
      const [existing] = await logs.appendChanges('t1', [change('node-a')]);

      await Promise.all([
        logs.removeChange('t1', existing.id),
        concurrent.appendChanges('t1', [change('node-b')]),
      ]);

      expect((await logs.readChanges('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);
    });

    // ── Intent episodes ─────────────────────────────────────────────────────

    it('reads no intents for a fresh Space', async () => {
      const { logs } = await open();
      await expect(logs.readIntents()).resolves.toEqual([]);
    });

    it('inserts a new episode and updates an existing one by id', async () => {
      const { logs } = await open();
      await logs.upsertIntent(episode('e1', 'first'));
      await logs.upsertIntent(episode('e2', 'second'));
      expect(await logs.readIntents()).toHaveLength(2);

      await logs.upsertIntent(episode('e1', 'revised'));
      const stored = await logs.readIntents();
      expect(stored).toHaveLength(2);
      const updated = stored.find((e) => e.id === 'e1');
      expect(
        updated?.outcome.type === 'selected' && updated.outcome.chosenLabel,
      ).toBe('revised');
    });

    it('does not lose an episode under concurrent upserts', async () => {
      const { logs, concurrent } = await open();
      await Promise.all([
        logs.upsertIntent(episode('e1', 'first')),
        concurrent.upsertIntent(episode('e2', 'second')),
      ]);

      expect((await logs.readIntents()).map((e) => e.id).sort()).toEqual([
        'e1',
        'e2',
      ]);
    });
  });
}
