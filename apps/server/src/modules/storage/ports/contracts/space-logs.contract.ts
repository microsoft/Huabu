// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable contracts for the log-backed parts a Space carries: its history
 * (behavioural events) and its pending change review.
 *
 * ⚠️ **Adapter-local guarantees.** As with the Space-record suite, the
 * linearizability properties asserted here belong to the adapter under test,
 * not to the running application: the compatibility facade is still a second
 * mutation entry point (docs/proposals/multi-backend-storage.md §12.2.3). A
 * green run is evidence about this adapter, not about single write authority.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import type { SpaceChanges, SpaceEvents } from '../structured.js';
import type { RecentAction } from '@huabu/shared';
import type {
  CanvasChangeRecord,
  CanvasNode,
} from '@huabu/shared/canvas-engine';

export interface SpaceLogs {
  events: SpaceEvents;
  changes: SpaceChanges;
}

export interface SpaceLogsHarness extends SpaceLogs {
  /**
   * A second set of parts for the same Space, so concurrency cases use
   * genuinely independent objects rather than one instance called twice.
   */
  concurrent: SpaceLogs;
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

export function describeSpaceLogsContract(
  name: string,
  createHarness: () => Promise<SpaceLogsHarness> | SpaceLogsHarness,
): void {
  describe(`Space log contracts (adapter-local): ${name}`, () => {
    let harness: SpaceLogsHarness | null = null;

    async function open(): Promise<SpaceLogsHarness> {
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

    it('deletes one record by id and reports a miss as null', async () => {
      const { changes } = await open();
      const stored = await changes.append('t1', [
        change('node-a'),
        change('node-b'),
      ]);
      const target = stored.find((r) => r.nodeId === 'node-a')!;

      const deleted = await changes.delete('t1', target.id);
      expect(deleted?.id).toBe(target.id);
      expect((await changes.read('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);

      await expect(changes.delete('t1', target.id)).resolves.toBeNull();
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

    it('does not lose a record when an append races a delete', async () => {
      const { changes, concurrent } = await open();
      const [existing] = await changes.append('t1', [change('node-a')]);

      await Promise.all([
        changes.delete('t1', existing.id),
        concurrent.changes.append('t1', [change('node-b')]),
      ]);

      expect((await changes.read('t1')).map((r) => r.nodeId)).toEqual([
        'node-b',
      ]);
    });
  });
}
