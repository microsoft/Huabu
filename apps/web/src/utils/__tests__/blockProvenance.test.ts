import { describe, expect, it } from 'vitest';

import {
  acceptAll,
  acceptBlock,
  type BlockSnapshot,
  coerceProvenance,
  diffBlocks,
  dismissDeletedBlock,
  emptyProvenance,
  findBlockEntry,
  findTombstonesAfter,
  fingerprintBlock,
  fingerprintBlocks,
  isMarkdownProvenance,
  shiftProvenance,
  stampAiEdit,
} from '../blockProvenance';

const para = (text: string): BlockSnapshot => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const heading = (level: number, text: string): BlockSnapshot => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

describe('fingerprintBlock', () => {
  it('is stable across attribute key ordering', () => {
    const a: BlockSnapshot = {
      type: 'paragraph',
      attrs: { a: 1, b: 2 },
      content: [{ type: 'text', text: 'hi' }],
    };
    const b: BlockSnapshot = {
      type: 'paragraph',
      attrs: { b: 2, a: 1 },
      content: [{ type: 'text', text: 'hi' }],
    };
    expect(fingerprintBlock(a)).toBe(fingerprintBlock(b));
  });

  it('changes when marks change (bold flip)', () => {
    const plain = para('hello');
    const bold: BlockSnapshot = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'hello', marks: [{ type: 'bold' }] }],
    };
    expect(fingerprintBlock(plain)).not.toBe(fingerprintBlock(bold));
  });

  it('changes when text changes', () => {
    expect(fingerprintBlock(para('a'))).not.toBe(fingerprintBlock(para('b')));
  });

  it('differs across types with same text', () => {
    expect(fingerprintBlock(para('hi'))).not.toBe(
      fingerprintBlock(heading(1, 'hi')),
    );
  });
});

describe('fingerprintBlocks (occurrence index)', () => {
  it('suffixes 2nd+ duplicates with #N', () => {
    const keys = fingerprintBlocks([
      para('x'),
      para('y'),
      para('x'),
      para('x'),
    ]);
    expect(keys[0]).not.toContain('#');
    expect(keys[1]).not.toContain('#');
    expect(keys[2]).toMatch(/#2$/);
    expect(keys[3]).toMatch(/#3$/);
    // first and 2nd 'x' share the base hash
    expect(keys[0]).toBe(keys[2].split('#')[0]);
  });
});

describe('diffBlocks', () => {
  it('detects pure insertion', () => {
    const r = diffBlocks(['A', 'B'], ['A', 'X', 'B']);
    expect(r.addedKeys).toEqual(['X']);
    expect(r.removedKeysWithAnchor).toEqual([]);
  });

  it('detects deletion with previous-surviving anchor', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'C']);
    expect(r.addedKeys).toEqual([]);
    expect(r.removedKeysWithAnchor).toEqual([{ key: 'B', anchorKey: 'A' }]);
  });

  it('reports null anchor for head deletion', () => {
    const r = diffBlocks(['A', 'B'], ['B']);
    expect(r.removedKeysWithAnchor).toEqual([{ key: 'A', anchorKey: null }]);
  });

  it('handles tail deletion', () => {
    const r = diffBlocks(['A', 'B'], ['A']);
    expect(r.removedKeysWithAnchor).toEqual([{ key: 'B', anchorKey: 'A' }]);
  });

  it('handles all-removed', () => {
    const r = diffBlocks(['A', 'B'], []);
    expect(r.removedKeysWithAnchor).toEqual([
      { key: 'A', anchorKey: null },
      { key: 'B', anchorKey: null },
    ]);
  });
});

describe('stampAiEdit', () => {
  const T0 = '2025-01-01T00:00:00.000Z';

  it('adds BlockProvenance for inserted keys', () => {
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A'],
      newKeys: ['A', 'X'],
      oldMarkdownByKey: new Map(),
      newMarkdownByKey: new Map([['X', 'inserted']]),
      at: T0,
    });
    expect(prov.blocks).toEqual([
      { key: 'X', kind: 'inserted', baselineMarkdown: '', at: T0 },
    ]);
    expect(prov.deletedBlocks).toEqual([]);
  });

  it('adds tombstone with anchor for deleted keys', () => {
    const prov = stampAiEdit(emptyProvenance(), {
      oldKeys: ['A', 'B', 'C'],
      newKeys: ['A', 'C'],
      oldMarkdownByKey: new Map([['B', 'old text']]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    expect(prov.blocks).toEqual([]);
    expect(prov.deletedBlocks).toEqual([
      { key: 'B', baselineMarkdown: 'old text', anchorKey: 'A', at: T0 },
    ]);
  });

  it('preserves existing entries whose key survives', () => {
    const before = stampAiEdit(undefined, {
      oldKeys: ['A'],
      newKeys: ['A', 'X'],
      oldMarkdownByKey: new Map(),
      newMarkdownByKey: new Map([['X', 'first ai add']]),
      at: '2025-01-01T00:00:00.000Z',
    });
    const after = stampAiEdit(before, {
      oldKeys: ['A', 'X'],
      newKeys: ['A', 'X', 'Y'],
      oldMarkdownByKey: new Map(),
      newMarkdownByKey: new Map(),
      at: '2025-01-02T00:00:00.000Z',
    });
    // X kept with its ORIGINAL `at`
    const x = after.blocks.find((b) => b.key === 'X');
    expect(x?.at).toBe('2025-01-01T00:00:00.000Z');
    expect(after.blocks.find((b) => b.key === 'Y')).toBeTruthy();
  });

  it('drops tombstones whose anchor was deleted in the same edit', () => {
    const seed = stampAiEdit(undefined, {
      oldKeys: ['A', 'B', 'C'],
      newKeys: ['A', 'C'],
      oldMarkdownByKey: new Map([['B', 'b']]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    expect(seed.deletedBlocks).toHaveLength(1);
    // Now AI also removes A — anchor of B is gone.
    const next = stampAiEdit(seed, {
      oldKeys: ['A', 'C'],
      newKeys: ['C'],
      oldMarkdownByKey: new Map([['A', 'a']]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    // The B-tombstone is dropped because its anchor 'A' no longer exists.
    expect(next.deletedBlocks.find((t) => t.key === 'B')).toBeUndefined();
    // A becomes its own tombstone, anchored at doc head (null).
    expect(next.deletedBlocks).toContainEqual({
      key: 'A',
      baselineMarkdown: 'a',
      anchorKey: null,
      at: T0,
    });
  });

  it("pairs add+remove in the same slot as a 'modified' block", () => {
    // ['A', 'B', 'C'] → ['A', 'B-prime', 'C']: B was edited.
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A', 'B', 'C'],
      newKeys: ['A', 'B-prime', 'C'],
      oldMarkdownByKey: new Map([['B', 'old B']]),
      newMarkdownByKey: new Map([['B-prime', 'new B']]),
      at: T0,
    });
    // No tombstone — the remove was paired up.
    expect(prov.deletedBlocks).toEqual([]);
    expect(prov.blocks).toEqual([
      { key: 'B-prime', kind: 'modified', baselineMarkdown: 'old B', at: T0 },
    ]);
  });

  it('extra removes within a slot fall through as tombstones', () => {
    // Two blocks removed, one inserted in the same slot →
    // 1 modification + 1 tombstone (anchored at A).
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A', 'B', 'C', 'D'],
      newKeys: ['A', 'B-prime', 'D'],
      oldMarkdownByKey: new Map([
        ['B', 'old B'],
        ['C', 'old C'],
      ]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    expect(prov.blocks).toEqual([
      { key: 'B-prime', kind: 'modified', baselineMarkdown: 'old B', at: T0 },
    ]);
    expect(prov.deletedBlocks).toEqual([
      { key: 'C', baselineMarkdown: 'old C', anchorKey: 'A', at: T0 },
    ]);
  });

  it('extra adds within a slot fall through as pure inserts', () => {
    // One block removed, two inserted in the same slot →
    // 1 modification + 1 pure insertion.
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A', 'B', 'D'],
      newKeys: ['A', 'B-prime', 'B-extra', 'D'],
      oldMarkdownByKey: new Map([['B', 'old B']]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    expect(prov.blocks).toEqual([
      { key: 'B-prime', kind: 'modified', baselineMarkdown: 'old B', at: T0 },
      { key: 'B-extra', kind: 'inserted', baselineMarkdown: '', at: T0 },
    ]);
    expect(prov.deletedBlocks).toEqual([]);
  });

  it('does not pair across slots separated by a surviving anchor', () => {
    // B removed in slot {A..C}; X inserted in slot {C..end}. Different
    // slots → NOT a modification.
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A', 'B', 'C'],
      newKeys: ['A', 'C', 'X'],
      oldMarkdownByKey: new Map([['B', 'old B']]),
      newMarkdownByKey: new Map(),
      at: T0,
    });
    expect(prov.blocks).toEqual([
      { key: 'X', kind: 'inserted', baselineMarkdown: '', at: T0 },
    ]);
    expect(prov.deletedBlocks).toEqual([
      { key: 'B', baselineMarkdown: 'old B', anchorKey: 'A', at: T0 },
    ]);
  });
});

describe('shiftProvenance', () => {
  it('drops entries whose key disappeared (user edit)', () => {
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A'],
      newKeys: ['A', 'X'],
      oldMarkdownByKey: new Map(),
      newMarkdownByKey: new Map(),
    });
    const shifted = shiftProvenance(prov, ['A', 'X-EDITED']);
    expect(shifted.blocks).toEqual([]);
  });

  it('drops tombstones whose anchor disappeared', () => {
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A', 'B'],
      newKeys: ['A'],
      oldMarkdownByKey: new Map([['B', 'gone']]),
      newMarkdownByKey: new Map(),
    });
    const shifted = shiftProvenance(prov, ['A-EDITED']);
    expect(shifted.deletedBlocks).toEqual([]);
  });

  it('keeps tombstones at doc head (anchorKey=null) regardless of liveKeys', () => {
    const prov = stampAiEdit(undefined, {
      oldKeys: ['A'],
      newKeys: [],
      oldMarkdownByKey: new Map([['A', 'gone']]),
      newMarkdownByKey: new Map(),
    });
    const shifted = shiftProvenance(prov, ['Z']);
    expect(shifted.deletedBlocks).toHaveLength(1);
    expect(shifted.deletedBlocks[0].anchorKey).toBeNull();
  });
});

describe('accept / dismiss helpers', () => {
  const seed = stampAiEdit(undefined, {
    oldKeys: ['A'],
    newKeys: ['A', 'X', 'Y'],
    oldMarkdownByKey: new Map(),
    newMarkdownByKey: new Map(),
  });

  it('acceptBlock removes a single entry', () => {
    const next = acceptBlock(seed, 'X');
    expect(next.blocks.map((b) => b.key)).toEqual(['Y']);
  });

  it('dismissDeletedBlock removes a single tombstone', () => {
    const withTomb = stampAiEdit(undefined, {
      oldKeys: ['A', 'B'],
      newKeys: ['A'],
      oldMarkdownByKey: new Map([['B', 'b']]),
      newMarkdownByKey: new Map(),
    });
    const next = dismissDeletedBlock(withTomb, 'B');
    expect(next.deletedBlocks).toEqual([]);
  });

  it('acceptAll empties everything', () => {
    expect(acceptAll(seed)).toEqual(emptyProvenance());
  });
});

describe('coerceProvenance / isMarkdownProvenance', () => {
  it('rejects legacy block-id-keyed map', () => {
    expect(isMarkdownProvenance({ blockA: { author: 'ai' } })).toBe(false);
    expect(coerceProvenance({ blockA: { author: 'ai' } })).toEqual(
      emptyProvenance(),
    );
  });

  it('accepts proper shape', () => {
    const p = emptyProvenance();
    expect(isMarkdownProvenance(p)).toBe(true);
  });
});

describe('lookup helpers', () => {
  // Pure delete + pure insert in different slots so the lookup helpers
  // see both a BlockProvenance entry AND a tombstone.
  const prov = stampAiEdit(undefined, {
    oldKeys: ['A', 'B', 'C'],
    newKeys: ['A', 'C', 'X'],
    oldMarkdownByKey: new Map([['B', 'b']]),
    newMarkdownByKey: new Map(),
  });

  it('findBlockEntry finds by key', () => {
    expect(findBlockEntry(prov, 'X')?.key).toBe('X');
    expect(findBlockEntry(prov, 'NOPE')).toBeUndefined();
  });

  it('findTombstonesAfter filters by anchor', () => {
    expect(findTombstonesAfter(prov, 'A').map((t) => t.key)).toEqual(['B']);
    expect(findTombstonesAfter(prov, null)).toEqual([]);
  });
});
