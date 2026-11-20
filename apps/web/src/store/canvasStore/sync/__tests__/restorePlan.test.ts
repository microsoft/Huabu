// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  applySharedPostEffectsFromWriteResult,
  executeCanvasCommands,
} from '@huabu/shared/canvas-engine';

import { deriveHeldKeys } from '../inFlight';
import { planRestore, type PlanState } from '../restorePlan';

import type { CanvasCommand } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

const CONTENT_KEYS = new Set(['content', 'label']);
const isContent = (unit: string): boolean =>
  unit.startsWith('data.') && CONTENT_KEYS.has(unit.slice(5));

function plan(before: PlanState, target: PlanState) {
  const run = (commands: CanvasCommand[]): PlanState => {
    const out = executeCanvasCommands(
      { source: 'ui', commands },
      {
        nodes: before.nodes as unknown as Node[],
        edges: before.edges as unknown as Edge[],
        canvasId: 'c1',
      },
    );
    const routed = applySharedPostEffectsFromWriteResult(out.writeResult);
    return {
      nodes: out.writeResult.nodes,
      edges: routed.edges,
    } as unknown as PlanState;
  };
  const result = planRestore({
    before,
    target,
    ignoreUnit: isContent,
    contentKeys: CONTENT_KEYS,
    run,
  });
  return { ...result, rerun: run(result.commands) };
}

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width: 200, height: 100 },
  data: { type: 'note', label: id, content: `${id} body`, heightMode: 'fixed' },
  ...extra,
});

describe('planRestore', () => {
  it('needs nothing when the states agree', () => {
    const state = { nodes: [note('a')], edges: [] };
    expect(plan(state, state)).toMatchObject({
      commands: [],
      followUp: [],
      exact: true,
    });
  });

  it('brings a deleted node and its edge back, in its old place in the order', () => {
    const a = note('a');
    const b = note('b', { position: { x: 300, y: 0 } });
    const edge = { id: 'e', source: 'a', target: 'b', sourceHandle: 'right' };
    const result = plan(
      { nodes: [b], edges: [] },
      { nodes: [a, b], edges: [edge] },
    );
    expect(result.commands).toEqual([
      { type: 'RESTORE_NODES', nodes: [a] },
      { type: 'RESTORE_NODES', nodes: [], edges: [edge] },
      { type: 'REORDER_NODES', nodeIds: ['a'], to: { before: 'b' } },
    ]);
    expect(result.restoredNodeIds).toEqual(['a']);
    expect(result.exact).toBe(true);
    expect(result.rerun.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('uses per-property commands for what they can say', () => {
    const before = note('a', {
      position: { x: 50, y: 60 },
      data: { ...note('a').data, pinned: true },
    });
    const result = plan(
      { nodes: [before], edges: [] },
      { nodes: [note('a')], edges: [] },
    );
    expect(result.commands).toEqual([
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 0, y: 0 } }],
      },
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: {}, unset: ['pinned'] }],
      },
    ]);
    expect(result.exact).toBe(true);
  });

  it('replaces a node whole when no property command reaches the snapshot, keeping its content', () => {
    // A top-level field no command sets.
    const target = note('a', { className: 'legacy' });
    const result = plan(
      {
        nodes: [
          note('a', {
            data: { ...note('a').data, content: 'typed since' },
          }),
        ],
        edges: [],
      },
      { nodes: [target], edges: [] },
    );
    expect(result.commands).toEqual([
      {
        type: 'RESTORE_NODES',
        nodes: [
          expect.objectContaining({
            id: 'a',
            className: 'legacy',
            data: { type: 'note', heightMode: 'fixed' },
          }),
        ],
        replace: ['a'],
        keepDataKeys: ['content', 'label'],
      },
    ]);
    expect(result.exact).toBe(true);
    // The body is not the batch's to write.
    expect((result.rerun.nodes[0].data as { content: string }).content).toBe(
      'typed since',
    );
  });

  it('leaves a returning Agent Node to its association and sends its edges afterwards', () => {
    const a = note('a');
    const question = {
      id: 'q',
      type: 'question',
      position: { x: 400, y: 0 },
      data: { type: 'question', threadId: 't1' },
    };
    const edge = { id: 'e', source: 'a', target: 'q' };
    const result = plan(
      { nodes: [a], edges: [] },
      { nodes: [question, a], edges: [edge] },
    );
    expect(result.commands).toEqual([]);
    expect(result.restoredQuestionIds).toEqual(['q']);
    expect(result.restoredNodeIds).toEqual([]);
    expect(result.followUp).toEqual([
      { type: 'REORDER_NODES', nodeIds: ['q'], to: { before: 'a' } },
      { type: 'RESTORE_NODES', nodes: [], edges: [edge] },
    ]);
    expect(result.exact).toBe(true);
  });

  it('reports the state the commands give when the engine lays a Frame out its own way', () => {
    const frame = {
      id: 'f',
      type: 'frame',
      position: { x: 0, y: 0 },
      // Not what a hug Frame around this child measures.
      style: { width: 900, height: 900 },
      data: { type: 'frame', sizing: 'hug' },
    };
    const child = note('a', { parentId: 'f', position: { x: 40, y: 80 } });
    const target = { nodes: [frame, child], edges: [] };
    const result = plan(
      {
        nodes: [frame, { ...child, position: { x: 300, y: 300 } }],
        edges: [],
      },
      target,
    );
    expect(result.commands.length).toBeGreaterThan(0);
    // Whatever the verdict, `result` is exactly what the commands produce.
    expect(deriveHeldKeys(result.rerun, result.result).size).toBe(0);
    expect(result.exact).toBe(
      deriveHeldKeys(result.result, target, isContent).size === 0,
    );
  });
});
