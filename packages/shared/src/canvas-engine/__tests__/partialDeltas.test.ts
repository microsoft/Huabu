// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Node rows carry only what changed: produced by the diff, merged by the one
 * applier, inverted for Review, and still readable in the whole-node format
 * they had before.
 */

import { describe, expect, it } from 'vitest';

import {
  applyDeltas,
  coalesceChanges,
  diffCanvasState,
  extractCanvasChanges,
  invertDelta,
  invertDeltas,
  isChangeStale,
  mergeNodeFields,
  slimDeltas,
  toWireDeltas,
  type CanvasEdge,
  type CanvasNode,
  type Delta,
} from '../index.js';

const BODY = 'x'.repeat(200_000);

function pdf(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'pdf-1',
    type: 'pdf',
    position: { x: 0, y: 0 },
    style: { width: 320, height: 420 },
    data: { label: 'Paper', src: 'artifacts/paper.pdf', content: BODY },
    ...overrides,
  } as CanvasNode;
}

function note(id: string, content: string, extra = {}): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 10, y: 20 },
    data: { label: `Note ${id}`, content, ...extra },
  } as CanvasNode;
}

const noEdges: CanvasEdge[] = [];
const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe('diffCanvasState: a replace carries only what differs', () => {
  it('moving a node with a large body carries its position, not the body', () => {
    const before = pdf();
    const after = pdf({ position: { x: 400, y: 80 } });
    const deltas = diffCanvasState(
      { nodes: [before], edges: noEdges },
      { nodes: [after], edges: noEdges },
    );
    expect(deltas).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'pdf',
        prev: { id: 'pdf-1', position: { x: 0, y: 0 } },
        next: { id: 'pdf-1', position: { x: 400, y: 80 } },
      },
    ]);
    expect(bytes(deltas)).toBeLessThan(300);
  });

  it('a data change carries only the keys that changed, with both values', () => {
    const before = note('n1', 'old body', { color: 'red', summary: 's' });
    const after = note('n1', 'new body', { color: 'red', keywords: ['k'] });
    const [delta] = diffCanvasState(
      { nodes: [before], edges: noEdges },
      { nodes: [after], edges: noEdges },
    );
    expect(delta).toEqual({
      type: 'REPLACE_NODE',
      nodeType: 'note',
      prev: { id: 'n1', data: { content: 'old body', summary: 's' } },
      next: { id: 'n1', data: { content: 'new body', keywords: ['k'] } },
    });
  });

  it('runtime fields alone, or a re-created equal node, yield no row', () => {
    const before = note('n1', 'body');
    const after = {
      ...before,
      data: { ...before.data },
      selected: true,
      measured: { width: 1, height: 2 },
    } as CanvasNode;
    expect(
      diffCanvasState(
        { nodes: [before], edges: noEdges },
        { nodes: [after], edges: noEdges },
      ),
    ).toEqual([]);
  });

  it('a deletion keeps the whole node until it is put on the wire', () => {
    const deltas = diffCanvasState(
      { nodes: [pdf()], edges: noEdges },
      { nodes: [], edges: noEdges },
    );
    expect(deltas).toEqual([{ type: 'DELETE_NODE', node: pdf() }]);
    const wire = toWireDeltas(deltas);
    expect(wire).toEqual([
      { type: 'DELETE_NODE', node: { id: 'pdf-1', type: 'pdf' } },
    ]);
    expect(bytes(wire)).toBeLessThan(100);
    expect(() => invertDelta(wire[0] as Delta)).toThrow(/does not hold/);
  });
});

describe('applyDeltas merges a replace into the node as it is now', () => {
  it('leaves fields the row does not name alone', () => {
    const current = note('n1', 'edited since', { color: 'blue' });
    const result = applyDeltas({ nodes: [current], edges: noEdges }, [
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: { id: 'n1', position: { x: 10, y: 20 } },
        next: { id: 'n1', position: { x: 99, y: 20 } },
      },
    ]);
    expect(result.nodes[0]).toEqual({
      ...current,
      position: { x: 99, y: 20 },
    });
  });

  it('removes a field only the previous side names, adds one only the next side names', () => {
    const current = note('n1', 'body', { summary: 's', color: 'red' });
    const merged = mergeNodeFields(
      { ...current, parentId: 'frame-1' } as CanvasNode,
      { id: 'n1', parentId: 'frame-1', data: { summary: 's' } },
      { id: 'n1', data: { keywords: ['k'] } },
    );
    expect(merged.parentId).toBeUndefined();
    expect('parentId' in merged).toBe(false);
    expect(merged.data).toEqual({
      label: 'Note n1',
      content: 'body',
      color: 'red',
      keywords: ['k'],
    });
  });

  it('round trips: applying the diff gives the next state, applying its inverse the previous', () => {
    const before = [note('n1', 'a', { color: 'red' }), pdf()];
    const after = [
      note('n1', 'b', { summary: 'new' }),
      pdf({ position: { x: 5, y: 5 }, parentId: 'f' } as Partial<CanvasNode>),
    ];
    const deltas = diffCanvasState(
      { nodes: before, edges: noEdges },
      { nodes: after, edges: noEdges },
    );
    const forward = applyDeltas({ nodes: before, edges: noEdges }, deltas);
    expect(forward.nodes).toEqual(after);
    const back = applyDeltas(
      { nodes: forward.nodes, edges: noEdges },
      invertDeltas(deltas),
    );
    expect(back.nodes).toEqual(before);
  });

  it('reads a whole-node row of the old format, and slims it to the same row', () => {
    const before = note('n1', 'old', { color: 'red' });
    const after = note('n1', 'new', { color: 'red' });
    const old: Delta = { type: 'REPLACE_NODE', prev: before, next: after };
    expect(
      applyDeltas({ nodes: [before], edges: noEdges }, [old]).nodes,
    ).toEqual([after]);
    expect(slimDeltas([old])).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: { id: 'n1', data: { content: 'old' } },
        next: { id: 'n1', data: { content: 'new' } },
      },
    ]);
    // A whole-node row that changes nothing is no row at all.
    expect(
      slimDeltas([{ type: 'REPLACE_NODE', prev: before, next: before }]),
    ).toEqual([]);
  });
});

describe('Review records from partial rows', () => {
  it('reverting an agent body edit restores the body and keeps a later move', () => {
    const before = note('n1', 'human text');
    const after = note('n1', 'agent text');
    const deltas = diffCanvasState(
      { nodes: [before], edges: noEdges },
      { nodes: [after], edges: noEdges },
    );
    const [record] = extractCanvasChanges(deltas, {
      nodeLabelById: new Map([['n1', 'Note n1']]),
      nodeTypeById: new Map([['n1', 'note']]),
    });
    expect(record).toMatchObject({
      kind: 'update',
      label: 'Updated: Note n1',
      nodeId: 'n1',
      nodeType: 'note',
      fingerprintKeys: ['content'],
      revertDeltas: [
        {
          type: 'REPLACE_NODE',
          nodeType: 'note',
          prev: { id: 'n1', data: { content: 'agent text' } },
          next: { id: 'n1', data: { content: 'human text' } },
        },
      ],
    });
    // Somebody moves the note afterwards: not stale, and the move survives.
    const moved = { ...after, position: { x: 500, y: 500 } } as CanvasNode;
    expect(isChangeStale(record!, [moved], noEdges)).toBe(false);
    const reverted = applyDeltas(
      { nodes: [moved], edges: noEdges },
      record!.revertDeltas,
    );
    expect(reverted.nodes[0]).toEqual({
      ...before,
      position: { x: 500, y: 500 },
    });
    // The body edited again makes it stale.
    const edited = note('n1', 'human again');
    expect(isChangeStale(record!, [edited], noEdges)).toBe(true);
  });

  it('the fingerprint of a partial row equals the one of the whole-node row', () => {
    const before = note('n1', 'old', { summary: 'kept' });
    const after = note('n1', 'new', { summary: 'kept' });
    const [partial] = extractCanvasChanges(
      diffCanvasState(
        { nodes: [before], edges: noEdges },
        { nodes: [after], edges: noEdges },
      ),
    );
    const [whole] = extractCanvasChanges([
      { type: 'REPLACE_NODE', prev: before, next: after },
    ]);
    expect(partial!.appliedFingerprint).toBe(whole!.appliedFingerprint);
    expect(partial!.fingerprintKeys).toEqual(whole!.fingerprintKeys);
    expect(partial!.revertDeltas).toEqual(whole!.revertDeltas);
  });

  it('reverting an agent delete brings the node back with its content', () => {
    const victim = pdf();
    const deltas = diffCanvasState(
      { nodes: [victim], edges: noEdges },
      { nodes: [], edges: noEdges },
    );
    const [record] = extractCanvasChanges(deltas);
    expect(record).toMatchObject({ kind: 'delete', nodeId: 'pdf-1' });
    expect(record!.revertDeltas).toEqual([
      { type: 'INSERT_NODE', node: victim },
    ]);
    expect(isChangeStale(record!, [], noEdges)).toBe(false);
    expect(
      applyDeltas({ nodes: [], edges: noEdges }, record!.revertDeltas).nodes,
    ).toEqual([victim]);
    // What travels cannot be reverted, and yields no record.
    expect(extractCanvasChanges(toWireDeltas(deltas))).toEqual([]);
  });

  it('coalesces two partial edits of one node into the net change', () => {
    const v0 = note('n1', 'zero', { color: 'red' });
    const v1 = note('n1', 'one', { color: 'red' });
    const v2 = {
      ...note('n1', 'one', { color: 'blue' }),
      position: { x: 1, y: 1 },
    };
    const known = { nodeLabelById: new Map([['n1', 'Note n1']]) };
    const first = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v0], edges: noEdges },
        { nodes: [v1], edges: noEdges },
      ),
      known,
    );
    const second = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v1], edges: noEdges },
        { nodes: [v2 as CanvasNode], edges: noEdges },
      ),
      known,
    );
    const net = coalesceChanges([...first, ...second]);
    expect(net).toHaveLength(1);
    expect(net[0]!.id).toBe(first[0]!.id);
    expect(net[0]!.nodeLabel).toBe('Note n1');
    expect(net[0]!.revertDeltas).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: {
          id: 'n1',
          position: { x: 1, y: 1 },
          data: { content: 'one', color: 'blue' },
        },
        next: {
          id: 'n1',
          position: { x: 10, y: 20 },
          data: { content: 'zero', color: 'red' },
        },
      },
    ]);
    expect(
      applyDeltas(
        { nodes: [v2 as CanvasNode], edges: noEdges },
        net[0]!.revertDeltas,
      ).nodes,
    ).toEqual([v0]);
  });

  it('an edit that is edited back, and a create that is deleted, net to nothing', () => {
    const v0 = note('n1', 'zero');
    const v1 = note('n1', 'one');
    const there = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v0], edges: noEdges },
        { nodes: [v1], edges: noEdges },
      ),
    );
    const back = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v1], edges: noEdges },
        { nodes: [v0], edges: noEdges },
      ),
    );
    expect(coalesceChanges([...there, ...back])).toEqual([]);

    const created = extractCanvasChanges([{ type: 'INSERT_NODE', node: v0 }]);
    const deleted = extractCanvasChanges([{ type: 'DELETE_NODE', node: v1 }]);
    expect(coalesceChanges([...created, ...deleted])).toEqual([]);
  });

  it('a create followed by an edit nets to a create of the edited node', () => {
    const v0 = note('n1', 'zero');
    const v1 = note('n1', 'one');
    const created = extractCanvasChanges([{ type: 'INSERT_NODE', node: v0 }]);
    const edited = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v0], edges: noEdges },
        { nodes: [v1], edges: noEdges },
      ),
    );
    const net = coalesceChanges([...created, ...edited]);
    expect(net).toHaveLength(1);
    expect(net[0]).toMatchObject({ kind: 'create', nodeId: 'n1' });
    expect(net[0]!.revertDeltas).toEqual([{ type: 'DELETE_NODE', node: v1 }]);
  });

  it('an edit followed by a delete reverts to the node before the edit', () => {
    const v0 = note('n1', 'zero', { color: 'red' });
    const v1 = note('n1', 'one', { color: 'red' });
    const edited = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v0], edges: noEdges },
        { nodes: [v1], edges: noEdges },
      ),
    );
    const deleted = extractCanvasChanges([{ type: 'DELETE_NODE', node: v1 }]);
    const net = coalesceChanges([...edited, ...deleted]);
    expect(net).toHaveLength(1);
    expect(net[0]!.revertDeltas).toEqual([{ type: 'INSERT_NODE', node: v0 }]);
  });

  it('coalesces records stored in the old whole-node format', () => {
    const v0 = note('n1', 'zero');
    const v1 = note('n1', 'one');
    const v2 = note('n1', 'two');
    const stored = [
      {
        id: 'change-a',
        kind: 'update' as const,
        label: 'Updated: Note n1',
        nodeId: 'n1',
        nodeType: 'note',
        nodeLabel: 'Note n1',
        revertDeltas: [{ type: 'REPLACE_NODE' as const, prev: v1, next: v0 }],
        fingerprintKeys: ['content'],
        appliedFingerprint: 'x',
      },
    ];
    const next = extractCanvasChanges(
      diffCanvasState(
        { nodes: [v1], edges: noEdges },
        { nodes: [v2], edges: noEdges },
      ),
    );
    const net = coalesceChanges([...stored, ...next]);
    expect(net).toHaveLength(1);
    expect(net[0]!.id).toBe('change-a');
    expect(net[0]!.revertDeltas).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: { id: 'n1', data: { content: 'two' } },
        next: { id: 'n1', data: { content: 'zero' } },
      },
    ]);
    expect(isChangeStale(net[0]!, [v2], noEdges)).toBe(false);
  });
});
