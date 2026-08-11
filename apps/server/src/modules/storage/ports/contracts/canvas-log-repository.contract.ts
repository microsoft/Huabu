// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable contracts for the four Canvas log-family repositories.
 *
 * ⚠️ **Adapter-local guarantees.** As with the Space-record suite, the
 * linearizability properties asserted here belong to the adapter under test,
 * not to the running application: the compatibility facade is still a second
 * mutation entry point (docs/proposals/multi-backend-storage.md §12.2.3). A
 * green run is evidence about this adapter, not about single write authority.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import type { DeltaLogEntry } from '../../../canvas/persistence-types.js';
import type {
  CanvasChangeRepository,
  CanvasDeltaRepository,
  CanvasEventRepository,
  CanvasIntentRepository,
} from '../structured.js';
import type { IntentEpisode, RecentAction } from '@huabu/shared';
import type {
  CanvasChangeRecord,
  CanvasNode,
} from '@huabu/shared/canvas-engine';

export interface CanvasLogRepositories {
  events: CanvasEventRepository;
  deltas: CanvasDeltaRepository;
  changes: CanvasChangeRepository;
  intents: CanvasIntentRepository;
}

export interface CanvasLogRepositoriesHarness extends CanvasLogRepositories {
  /**
   * A second set of repository handles for the same Space, so concurrency
   * cases use genuinely independent objects rather than one instance called
   * twice.
   */
  concurrent: CanvasLogRepositories;
  /** Fixture-only setup; durable delta writes belong to SpaceHandle.commit. */
  seedDeltas(entries: readonly DeltaLogEntry[]): Promise<void> | void;
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
  return (payload as Extract<RecentAction, { action: 'node_selected' }>).node
    .id;
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

export function describeCanvasLogRepositoriesContract(
  name: string,
  createHarness: () =>
    | Promise<CanvasLogRepositoriesHarness>
    | CanvasLogRepositoriesHarness,
): void {
  describe(`Canvas log repository contracts (adapter-local): ${name}`, () => {
    let harness: CanvasLogRepositoriesHarness | null = null;

    async function open(): Promise<CanvasLogRepositoriesHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    // ── Events ──────────────────────────────────────────────────────────────

    it('reads an empty event log as an empty list', async () => {
      const { events } = await open();
      await expect(events.read()).resolves.toEqual([]);
    });

    it('ignores an empty append', async () => {
      const { events } = await open();
      await events.append([]);
      await expect(events.read()).resolves.toEqual([]);
    });

    it('preserves append order across batches', async () => {
      const { events } = await open();
      await events.append([
        { payload: action('a'), ts: 1 },
        { payload: action('b'), ts: 2 },
      ]);
      await events.append([{ payload: action('c'), ts: 3 }]);

      const stored = await events.read();
      expect(stored.map((e) => e.ts)).toEqual([1, 2, 3]);
    });

    it('defaults a missing timestamp to server time', async () => {
      const { events } = await open();
      const before = Date.now();
      await events.append([{ payload: action('a') }]);

      const [event] = await events.read();
      expect(event.ts).toBeGreaterThanOrEqual(before);
    });

    it('returns the most recent records when limited', async () => {
      const { events } = await open();
      await events.append(
        [1, 2, 3, 4, 5].map((ts) => ({ payload: action(`n${ts}`), ts })),
      );

      const tail = await events.read(2);
      expect(tail.map((e) => e.ts)).toEqual([4, 5]);
    });

    it('keeps one batch contiguous under a concurrent append', async () => {
      const { events, concurrent } = await open();
      await Promise.all([
        events.append([
          { payload: action('a1'), ts: 1 },
          { payload: action('a2'), ts: 2 },
          { payload: action('a3'), ts: 3 },
        ]),
        concurrent.events.append([
          { payload: action('b1'), ts: 4 },
          { payload: action('b2'), ts: 5 },
        ]),
      ]);

      const stored = await events.read();
      expect(stored).toHaveLength(5);
      // Neither batch is split by the other: each appears as one run.
      const ids = stored.map((e) => actionNodeId(e.payload)).join(',');
      expect(ids).toContain('a1,a2,a3');
      expect(ids).toContain('b1,b2');
    });

    // ── Delta log ───────────────────────────────────────────────────────────

    it('reads an empty delta log as an empty list', async () => {
      const { deltas } = await open();
      await expect(deltas.readSince(0)).resolves.toEqual([]);
    });

    it('filters deltas strictly greater than the requested version', async () => {
      const { deltas, seedDeltas } = await open();
      await seedDeltas([delta(1), delta(2), delta(3)]);

      expect((await deltas.readSince(0)).map((d) => d.version)).toEqual([
        1, 2, 3,
      ]);
      expect((await deltas.readSince(2)).map((d) => d.version)).toEqual([3]);
      expect(await deltas.readSince(3)).toEqual([]);
    });

    it('exposes no delta mutation method', async () => {
      const { deltas } = await open();
      expect(deltas).not.toHaveProperty('append');
      expect(Object.keys(deltas)).toEqual(['readSince']);
    });

    // ── Change-review records ───────────────────────────────────────────────

    it('reads an unknown thread as an empty list', async () => {
      const { changes } = await open();
      await expect(changes.read('thread-x')).resolves.toEqual([]);
    });

    it('coalesces changes for the same entity', async () => {
      const { changes } = await open();
      const merged = await changes.append('t1', [
        change('node-a', 'first'),
        change('node-a', 'second'),
        change('node-b', 'other'),
      ]);

      expect(merged.map((r) => r.nodeId).sort()).toEqual(['node-a', 'node-b']);
      // What `append` returns is what a later read observes.
      expect(await changes.read('t1')).toEqual(merged);
    });

    it('scopes changes by thread', async () => {
      const { changes } = await open();
      await changes.append('t1', [change('node-a')]);
      await changes.append('t2', [change('node-b')]);

      expect((await changes.read('t1')).map((r) => r.nodeId)).toEqual([
        'node-a',
      ]);
      expect((await changes.read('t2')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);
    });

    it('removes one record by id and reports a miss as null', async () => {
      const { changes } = await open();
      const stored = await changes.append('t1', [
        change('node-a'),
        change('node-b'),
      ]);
      const target = stored.find((r) => r.nodeId === 'node-a')!;

      const removed = await changes.remove('t1', target.id);
      expect(removed?.id).toBe(target.id);
      expect((await changes.read('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);

      await expect(changes.remove('t1', target.id)).resolves.toBeNull();
    });

    it('does not lose a record when two agents append concurrently', async () => {
      const { changes, concurrent } = await open();
      // From one tick: a read → merge → write that is not one turn would let
      // the second append overwrite the first's record instead of merging it.
      await Promise.all([
        changes.append('t1', [change('node-a')]),
        concurrent.changes.append('t1', [change('node-b')]),
      ]);

      expect((await changes.read('t1')).map((r) => r.nodeId).sort()).toEqual([
        'node-a',
        'node-b',
      ]);
    });

    it('does not lose a record when an append races a removal', async () => {
      const { changes, concurrent } = await open();
      const [existing] = await changes.append('t1', [change('node-a')]);

      await Promise.all([
        changes.remove('t1', existing.id),
        concurrent.changes.append('t1', [change('node-b')]),
      ]);

      expect((await changes.read('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);
    });

    // ── Intent episodes ─────────────────────────────────────────────────────

    it('reads no intents for a fresh Space', async () => {
      const { intents } = await open();
      await expect(intents.read()).resolves.toEqual([]);
    });

    it('inserts a new episode and updates an existing one by id', async () => {
      const { intents } = await open();
      await intents.upsert(episode('e1', 'first'));
      await intents.upsert(episode('e2', 'second'));
      expect(await intents.read()).toHaveLength(2);

      await intents.upsert(episode('e1', 'revised'));
      const stored = await intents.read();
      expect(stored).toHaveLength(2);
      const updated = stored.find((e) => e.id === 'e1');
      expect(
        updated?.outcome.type === 'selected' && updated.outcome.chosenLabel,
      ).toBe('revised');
    });

    it('does not lose an episode under concurrent upserts', async () => {
      const { intents, concurrent } = await open();
      await Promise.all([
        intents.upsert(episode('e1', 'first')),
        concurrent.intents.upsert(episode('e2', 'second')),
      ]);

      expect((await intents.read()).map((e) => e.id).sort()).toEqual([
        'e1',
        'e2',
      ]);
    });
  });
}
