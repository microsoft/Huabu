import { describe, it, expect } from 'vitest';

import {
  applyDeltas,
  extractCanvasChanges,
  fingerprintNode,
  invertDeltas,
  type Delta,
} from '../index.js';

import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function note(id: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id, type: 'note', position: { x: 0, y: 0 }, data } as CanvasNode;
}

function edge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target } as CanvasEdge;
}

describe('invertDeltas', () => {
  it('round-trips: applying deltas then their inverse restores the state', () => {
    const a = note('node-a', { label: 'A', content: 'old' });
    const start = { nodes: [a], edges: [] as CanvasEdge[] };

    const aNext = note('node-a', { label: 'A', content: 'new' });
    const b = note('node-b', { label: 'B' });
    const deltas: Delta[] = [
      { type: 'REPLACE_NODE', prev: a, next: aNext },
      { type: 'INSERT_NODE', node: b },
    ];

    const after = applyDeltas(start, deltas);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(['node-a', 'node-b']);

    const reverted = applyDeltas(after, invertDeltas(deltas));
    expect(reverted.nodes).toHaveLength(1);
    const restored = reverted.nodes.find((n) => n.id === 'node-a');
    expect((restored?.data as { content?: string }).content).toBe('old');
  });

  it('inverts in reverse order', () => {
    const b = note('node-b');
    const deltas: Delta[] = [
      { type: 'INSERT_NODE', node: note('node-a') },
      { type: 'INSERT_NODE', node: b },
    ];
    const inv = invertDeltas(deltas);
    expect(inv[0]).toEqual({ type: 'DELETE_NODE', node: b });
  });
});

describe('fingerprintNode', () => {
  it('is stable for equal content and differs for different content', () => {
    expect(fingerprintNode(note('n', { content: 'A' }))).toBe(
      fingerprintNode(note('n', { content: 'A' })),
    );
    expect(fingerprintNode(note('n', { content: 'A' }))).not.toBe(
      fingerprintNode(note('n', { content: 'B' })),
    );
  });

  it('is order-independent over data keys', () => {
    const x = {
      id: 'n',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { a: 1, b: 2 },
    } as CanvasNode;
    const y = {
      id: 'n',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { b: 2, a: 1 },
    } as CanvasNode;
    expect(fingerprintNode(x)).toBe(fingerprintNode(y));
  });
});

describe('extractCanvasChanges', () => {
  it('INSERT_NODE → create record, revert deletes the node', () => {
    const n = note('node-a', { label: 'Market analysis', content: 'hi' });
    const [rec] = extractCanvasChanges([{ type: 'INSERT_NODE', node: n }]);

    expect(rec.kind).toBe('create');
    expect(rec.label).toBe('Created: Market analysis');
    expect(rec.nodeId).toBe('node-a');
    expect(rec.revertDeltas).toEqual([{ type: 'DELETE_NODE', node: n }]);
    expect(rec.appliedFingerprint).toBe(fingerprintNode(n));
  });

  it('REPLACE_NODE → update record, revert restores prev (with content)', () => {
    const prev = note('node-b', { label: 'Draft', content: 'OLD' });
    const next = note('node-b', { label: 'Draft', content: 'NEW' });
    const [rec] = extractCanvasChanges([{ type: 'REPLACE_NODE', prev, next }]);

    expect(rec.kind).toBe('update');
    expect(rec.label).toBe('Updated: Draft');
    expect(rec.revertDeltas).toEqual([
      { type: 'REPLACE_NODE', prev: next, next: prev },
    ]);
    // Fingerprint reflects the POST-apply (next) state.
    expect(rec.appliedFingerprint).toBe(fingerprintNode(next));
  });

  it('DELETE_NODE → delete record, revert reinserts the node', () => {
    const n = note('node-c', { label: 'Gone' });
    const [rec] = extractCanvasChanges([{ type: 'DELETE_NODE', node: n }]);

    expect(rec.kind).toBe('delete');
    expect(rec.label).toBe('Deleted: Gone');
    expect(rec.revertDeltas).toEqual([{ type: 'INSERT_NODE', node: n }]);
  });

  it('INSERT_EDGE → connect record with endpoint labels, revert disconnects', () => {
    const a = note('node-a', { label: 'A' });
    const e = edge('edge-1', 'node-a', 'node-b');
    const [rec] = extractCanvasChanges([{ type: 'INSERT_EDGE', edge: e }], {
      nodeLabelById: new Map([
        ['node-a', 'A'],
        ['node-b', 'B'],
      ]),
    });
    void a;

    expect(rec.kind).toBe('connect');
    expect(rec.sourceNodeId).toBe('node-a');
    expect(rec.targetNodeId).toBe('node-b');
    expect(rec.sourceNodeLabel).toBe('A');
    expect(rec.targetNodeLabel).toBe('B');
    expect(rec.revertDeltas).toEqual([{ type: 'DELETE_EDGE', edge: e }]);
  });

  it('mixed batch → one record per delta, distinct ids, order preserved', () => {
    const created = note('node-a', { label: 'New' });
    const prev = note('node-b', { label: 'Draft', content: 'OLD' });
    const next = note('node-b', { label: 'Draft', content: 'NEW' });
    const e = edge('edge-1', 'node-a', 'node-b');

    const records = extractCanvasChanges([
      { type: 'INSERT_NODE', node: created },
      { type: 'REPLACE_NODE', prev, next },
      { type: 'INSERT_EDGE', edge: e },
    ]);

    expect(records.map((r) => r.kind)).toEqual(['create', 'update', 'connect']);
    expect(new Set(records.map((r) => r.id)).size).toBe(3);
    // Edge endpoint label harvested from the batch's own node delta.
    expect(records[2].sourceNodeLabel).toBe('New');
  });

  it('per-record revert round-trips through applyDeltas', () => {
    const prev = note('node-b', { label: 'Draft', content: 'OLD' });
    const next = note('node-b', { label: 'Draft', content: 'NEW' });
    const start = { nodes: [prev], edges: [] as CanvasEdge[] };
    const after = applyDeltas(start, [{ type: 'REPLACE_NODE', prev, next }]);

    const [rec] = extractCanvasChanges([{ type: 'REPLACE_NODE', prev, next }]);
    const reverted = applyDeltas(after, rec.revertDeltas);
    expect((reverted.nodes[0].data as { content?: string }).content).toBe(
      'OLD',
    );
  });
});
