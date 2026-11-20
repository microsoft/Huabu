// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { toExecuteResponse } from './canvas-executor.js';
import {
  outcomeOf,
  readStoredOutcome,
  replayedOutput,
  storableOutcome,
} from './execute-outcome.js';

import type { ExecuteOnServerOutput } from './canvas-executor.js';
import type { CanvasCommand } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const BODY = 'b'.repeat(50_000);
const created: CanvasNode = {
  id: 'node-new',
  type: 'note',
  position: { x: 0, y: 0 },
  data: { label: 'New', content: BODY },
};
const create = {
  type: 'CREATE_NODES',
  nodes: [
    { id: 'node-new', nodeType: 'note', data: { label: 'New', content: BODY } },
  ],
} as unknown as CanvasCommand;
const remove = {
  type: 'DELETE_NODES',
  nodeIds: ['node-gone', 'node-missing'],
} as unknown as CanvasCommand;

/** What one call returns in process: deltas, nodes and commands included. */
function live(): ExecuteOnServerOutput {
  return {
    canvasId: 'c1',
    fromVersion: 4,
    toVersion: 5,
    deltas: [
      { type: 'INSERT_NODE', node: created },
      {
        type: 'DELETE_NODE',
        node: { ...created, id: 'node-gone', data: { content: BODY } },
      },
    ],
    edits: [
      { applied: true, start: 0, count: 1 },
      { applied: true, start: 1, count: 1 },
    ],
    results: [
      {
        command: create,
        applied: true,
        nodes: [{ nodeId: 'node-new', label: 'New', width: 200, height: 100 }],
      },
      { command: remove, applied: true },
    ],
    commands: [create, remove],
    pendingEffects: {
      mutatedNodes: [created],
      deletedNodeIds: ['node-gone'],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
    nodeContentRevisions: { 'node-new': 'rev-1' },
    basis: 'b1.lineage.5',
    operationId: '11111111-1111-4111-8111-111111111111',
    runId: 'run-1',
  };
}

describe('the outcome of an execute request', () => {
  it('holds results, ids and versions, and nothing of what the request changed', () => {
    const outcome = outcomeOf(live(), false);
    expect(outcome).toEqual({
      v: 2,
      canvasId: 'c1',
      fromVersion: 4,
      toVersion: 5,
      runId: 'run-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      basis: 'b1.lineage.5',
      edits: [
        { applied: true, start: 0, count: 1 },
        { applied: true, start: 1, count: 1 },
      ],
      results: [
        {
          type: 'CREATE_NODES',
          applied: true,
          nodes: [
            { nodeId: 'node-new', label: 'New', width: 200, height: 100 },
          ],
        },
        { type: 'DELETE_NODES', applied: true },
      ],
      affected: {
        nodeIds: ['node-new', 'node-gone', 'node-missing'],
        edgeIds: [],
        deletedNodeIds: ['node-gone'],
        deletedEdgeIds: [],
      },
      revisions: [{ nodeId: 'node-new', rev: expect.any(String) }],
      pendingEffects: {
        mutatedNodeIds: ['node-new'],
        deletedNodeIds: ['node-gone'],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
      nodeContentRevisions: { 'node-new': 'rev-1' },
    });
    expect(JSON.stringify(outcome)).not.toContain(BODY.slice(0, 64));
    expect(JSON.stringify(outcome).length).toBeLessThan(1_000);
    // Only an entry whose response echoes the commands keeps them.
    expect(outcomeOf(live(), true).commands).toEqual([create, remove]);
  });

  it('answers a repeat as the first call was answered, without deltas', () => {
    const first = live();
    const replay = replayedOutput(outcomeOf(first, false));
    const { deltas, ...answer } = toExecuteResponse(first);
    expect(deltas).toHaveLength(2);
    expect(toExecuteResponse(replay)).toEqual({ ...answer, replayed: true });
    expect(replay.deltas).toEqual([]);
    expect(replay.pendingEffects.mutatedNodes).toEqual([]);
  });

  it('reads a record stored before outcomes existed: the whole response of that call', () => {
    // Exactly what used to be stored: the in-process output.
    const stored = JSON.parse(JSON.stringify(live())) as Record<
      string,
      unknown
    >;
    delete stored['edits'];
    const outcome = readStoredOutcome(stored);
    expect(outcome).toEqual({
      ...outcomeOf(live(), true),
      // The old form had no edits: each command stood for itself.
      edits: [
        { applied: true, start: 0, count: 1 },
        { applied: true, start: 1, count: 1 },
      ],
    });
    // A refused command of that time is a refused edit now.
    const refused = readStoredOutcome({
      ...stored,
      results: [
        { command: create, applied: false, reason: 'stale-target' },
        { command: remove, applied: false, reason: 'no-op' },
      ],
    });
    expect(refused?.edits).toEqual([
      {
        applied: false,
        reason: 'stale-target',
        failedAt: 0,
        start: 0,
        count: 1,
      },
      { applied: true, start: 1, count: 1 },
    ]);
    expect(readStoredOutcome(null)).toBeNull();
    expect(readStoredOutcome({ v: 3 })).toBeNull();
    expect(readStoredOutcome({ canvasId: 'c1' })).toBeNull();
  });

  it('gives up its optional parts, then all but the results, to fit a record', () => {
    const whole = outcomeOf(live(), true);
    expect(storableOutcome(whole)).toBe(whole);

    // Too large with the command echo: stored without it.
    const reduced = storableOutcome(whole, 2_000);
    expect(reduced).toMatchObject({
      incomplete: true,
      edits: whole.edits,
      affected: whole.affected,
      revisions: whole.revisions,
      results: [
        { type: 'CREATE_NODES', applied: true },
        { type: 'DELETE_NODES', applied: true },
      ],
    });
    expect(reduced?.commands).toBeUndefined();
    expect(reduced?.results[0]?.nodes).toBeUndefined();

    // Smaller still: who, which versions, what became of each edit.
    const size = (value: unknown) => JSON.stringify(value).length;
    const minimal = storableOutcome(whole, size(reduced) - 1);
    expect(minimal).toMatchObject({
      incomplete: true,
      canvasId: 'c1',
      fromVersion: 4,
      toVersion: 5,
      operationId: whole.operationId,
      edits: whole.edits,
      affected: { nodeIds: [] },
    });
    expect(minimal?.nodeContentRevisions).toBeUndefined();
    // Only a record that cannot hold even that is not stored.
    expect(size(minimal)).toBeLessThan(size(reduced));
    expect(storableOutcome(whole, size(minimal) - 1)).toBeNull();
  });
});
