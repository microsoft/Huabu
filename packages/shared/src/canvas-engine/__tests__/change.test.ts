// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import {
  applyDeltas,
  coalesceChanges,
  extractCanvasChanges,
  fingerprintNodeFields,
  nodeRevision,
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

describe('fingerprintNodeFields', () => {
  it('is stable for equal values and differs for different values', () => {
    expect(
      fingerprintNodeFields(note('n', { content: 'A' }), ['content']),
    ).toBe(fingerprintNodeFields(note('n', { content: 'A' }), ['content']));
    expect(
      fingerprintNodeFields(note('n', { content: 'A' }), ['content']),
    ).not.toBe(fingerprintNodeFields(note('n', { content: 'B' }), ['content']));
  });

  it('only hashes the requested keys — other fields are ignored', () => {
    const a = note('n', { content: 'A', label: 'X', summary: 's1' });
    const b = note('n', { content: 'A', label: 'Y', summary: 's2' });
    // Same `content`, different everything else → equal over ['content'].
    expect(fingerprintNodeFields(a, ['content'])).toBe(
      fingerprintNodeFields(b, ['content']),
    );
  });

  it('is order-independent over the key set', () => {
    const n = note('n', { a: 1, b: 2 });
    expect(fingerprintNodeFields(n, ['a', 'b'])).toBe(
      fingerprintNodeFields(n, ['b', 'a']),
    );
  });
});

describe('nodeRevision', () => {
  it('is stable for equal authored content', () => {
    expect(nodeRevision(note('n', { content: 'A' }))).toBe(
      nodeRevision(note('n', { content: 'A' })),
    );
  });

  it('moves when the body (`content`) or media ref (`src`) changes', () => {
    expect(nodeRevision(note('n', { content: 'A' }))).not.toBe(
      nodeRevision(note('n', { content: 'B' })),
    );
    expect(nodeRevision(note('n', { src: 'artifact-1.png' }))).not.toBe(
      nodeRevision(note('n', { src: 'artifact-2.png' })),
    );
  });

  it('ignores auto-derived / cosmetic fields (label, summary, keywords, style)', () => {
    const a = note('n', { content: 'A', label: 'X', summary: 's1' });
    const b = note('n', {
      content: 'A',
      label: 'Y',
      summary: 's2',
      keywords: ['k'],
      style: { color: 'red' },
    });
    expect(nodeRevision(a)).toBe(nodeRevision(b));
  });
});

describe('staleness scoping (per-change fingerprintKeys)', () => {
  it('CREATE fingerprints the body; ignores a later label/summary rewrite, catches a body edit', () => {
    const created = note('n', {
      content: 'hello world',
      label: 'hello world 1',
    });
    const [rec] = extractCanvasChanges([
      { type: 'INSERT_NODE', node: created },
    ]);
    expect(rec.fingerprintKeys).toEqual(['content']);

    // Preprocessing stamps summary/keywords and regenerates the label → fresh.
    const afterPreprocess = note('n', {
      content: 'hello world',
      label: 'A friendly greeting',
      summary: 'greeting',
      keywords: ['hello'],
      labelSource: 'auto',
      autoHeight: { intrinsicHeight: 1305, measuredFor: '1:abc' },
    });
    expect(fingerprintNodeFields(afterPreprocess, rec.fingerprintKeys!)).toBe(
      rec.appliedFingerprint,
    );

    // The user edits the note body → stale (delete-revert would wipe it).
    const bodyEdited = note('n', { content: 'hello world, edited' });
    expect(fingerprintNodeFields(bodyEdited, rec.fingerprintKeys!)).not.toBe(
      rec.appliedFingerprint,
    );
  });

  it('UPDATE(content) ignores a later label rewrite but catches a content re-edit', () => {
    const prev = note('n', { content: 'old', label: 'L' });
    const next = note('n', { content: 'new', label: 'L' });
    const [rec] = extractCanvasChanges([{ type: 'REPLACE_NODE', prev, next }]);
    expect(rec.fingerprintKeys).toEqual(['content']);

    // Preprocessing regenerates the label → still fresh.
    const labelOnly = note('n', { content: 'new', label: 'L2', summary: 's' });
    expect(fingerprintNodeFields(labelOnly, rec.fingerprintKeys!)).toBe(
      rec.appliedFingerprint,
    );

    // A human re-edits the content → stale (revert would clobber it).
    const contentEdited = note('n', { content: 'newer', label: 'L' });
    expect(fingerprintNodeFields(contentEdited, rec.fingerprintKeys!)).not.toBe(
      rec.appliedFingerprint,
    );
  });

  it('UPDATE(rename) scopes to label so an agent rename is protected', () => {
    const prev = note('n', { content: 'c', label: 'Old name' });
    const next = note('n', { content: 'c', label: 'New name' });
    const [rec] = extractCanvasChanges([{ type: 'REPLACE_NODE', prev, next }]);
    expect(rec.fingerprintKeys).toEqual(['label']);

    // Someone renames again → stale (revert would clobber the newer name).
    const renamedAgain = note('n', { content: 'c', label: 'Newest name' });
    expect(fingerprintNodeFields(renamedAgain, rec.fingerprintKeys!)).not.toBe(
      rec.appliedFingerprint,
    );
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
    // CREATE fingerprints the authored body (content).
    expect(rec.fingerprintKeys).toEqual(['content']);
    expect(rec.appliedFingerprint).toBe(fingerprintNodeFields(n, ['content']));
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
    // UPDATE fingerprints only the fields that actually changed (content).
    expect(rec.fingerprintKeys).toEqual(['content']);
    expect(rec.appliedFingerprint).toBe(
      fingerprintNodeFields(next, ['content']),
    );
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
    expect(rec.label).toBe('Connected: A → B');
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

describe('coalesceChanges', () => {
  const recs = (...deltas: Delta[]) =>
    deltas.flatMap((d) => extractCanvasChanges([d]));

  it('create → update(s) collapses to one create with the latest body', () => {
    const a1 = note('A', { content: 'v1' });
    const a2 = note('A', { content: 'v2' });
    const merged = coalesceChanges([
      ...recs({ type: 'INSERT_NODE', node: a1 }),
      ...recs({ type: 'REPLACE_NODE', prev: a1, next: a2 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe('create');
    expect(merged[0].revertDeltas).toEqual([{ type: 'DELETE_NODE', node: a2 }]);
  });

  it('update → update collapses; revert restores the pre-first state', () => {
    const a1 = note('A', { content: 'v1' });
    const a2 = note('A', { content: 'v2' });
    const a3 = note('A', { content: 'v3' });
    const first = recs({ type: 'REPLACE_NODE', prev: a1, next: a2 });
    const merged = coalesceChanges([
      ...first,
      ...recs({ type: 'REPLACE_NODE', prev: a2, next: a3 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe('update');
    expect(merged[0].revertDeltas).toEqual([
      { type: 'REPLACE_NODE', prev: a3, next: a1 },
    ]);
    // Stable id — keeps the first constituent's id.
    expect(merged[0].id).toBe(first[0].id);
  });

  it('create → delete cancels out to nothing', () => {
    const a = note('A', { content: 'v1' });
    const merged = coalesceChanges([
      ...recs({ type: 'INSERT_NODE', node: a }),
      ...recs({ type: 'DELETE_NODE', node: a }),
    ]);
    expect(merged).toEqual([]);
  });

  it('update → delete collapses to a delete restoring the original', () => {
    const a1 = note('A', { content: 'v1' });
    const a2 = note('A', { content: 'v2' });
    const merged = coalesceChanges([
      ...recs({ type: 'REPLACE_NODE', prev: a1, next: a2 }),
      ...recs({ type: 'DELETE_NODE', node: a2 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe('delete');
    expect(merged[0].revertDeltas).toEqual([{ type: 'INSERT_NODE', node: a1 }]);
  });

  it('keeps distinct entities as separate rows in first-seen order', () => {
    const a = note('A', { content: 'a' });
    const b = note('B', { content: 'b' });
    const merged = coalesceChanges([
      ...recs({ type: 'INSERT_NODE', node: a }),
      ...recs({ type: 'INSERT_NODE', node: b }),
    ]);
    expect(merged.map((r) => r.nodeId)).toEqual(['A', 'B']);
  });

  it('is idempotent (coalescing an already-coalesced list is a no-op)', () => {
    const a1 = note('A', { content: 'v1' });
    const a2 = note('A', { content: 'v2' });
    const once = coalesceChanges([
      ...recs({ type: 'REPLACE_NODE', prev: a1, next: a2 }),
    ]);
    expect(coalesceChanges(once)).toEqual(once);
  });
});
