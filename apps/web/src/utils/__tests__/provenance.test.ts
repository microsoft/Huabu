import { describe, it, expect } from 'vitest';

import {
  expandSentinelProvenance,
  recordUserEdit,
  recordUserEdits,
  getBlockAuthorStatus,
  hasAnyPureAiBlock,
  blockFingerprint,
  extractBlockText,
  mergeProvenanceAfterAIUpdate,
  deriveBlockDiffMap,
  deriveDeletedBlocks,
  clearBaselineText,
  clearAllBaselines,
  removeDeletedEntry,
  hasAnyPendingDiff,
  getDeletedKeys,
  repairDeletedBlockAnchors,
} from '../provenance';

import type { ProvenanceBlock } from '../provenance';
import type { BlockProvenance, BlockProvenanceMap } from '@sediment/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(
  id: string,
  text: string,
  type = 'paragraph',
): ProvenanceBlock {
  return {
    id,
    type,
    content: text ? [{ type: 'text', text }] : [],
  };
}

function makeAiEntry(overrides?: Partial<BlockProvenance>): BlockProvenance {
  return { author: 'ai', createdAt: '2025-01-01T00:00:00Z', ...overrides };
}

function makeUserEntry(overrides?: Partial<BlockProvenance>): BlockProvenance {
  return { author: 'user', createdAt: '2025-01-01T00:00:00Z', ...overrides };
}

const sentinel: BlockProvenance = {
  author: 'ai',
  createdAt: '2025-06-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// extractBlockText / blockFingerprint
// ---------------------------------------------------------------------------

describe('extractBlockText', () => {
  it('extracts text from inline content', () => {
    const block = makeBlock('a', 'Hello World');
    expect(extractBlockText(block)).toBe('Hello World');
  });

  it('returns empty string for empty content', () => {
    const block: ProvenanceBlock = { id: 'a', type: 'paragraph', content: [] };
    expect(extractBlockText(block)).toBe('');
  });

  it('recurses into children', () => {
    const block: ProvenanceBlock = {
      id: 'a',
      type: 'paragraph',
      content: [{ type: 'text', text: 'Parent' }],
      children: [makeBlock('b', 'Child')],
    };
    expect(extractBlockText(block)).toBe('Parent\nChild');
  });
});

describe('blockFingerprint', () => {
  it('creates type::text fingerprint', () => {
    const block = makeBlock('a', 'Hello');
    expect(blockFingerprint(block)).toBe('paragraph::Hello');
  });

  it('distinguishes block types', () => {
    const p = makeBlock('a', 'Hello', 'paragraph');
    const h = makeBlock('b', 'Hello', 'heading');
    expect(blockFingerprint(p)).not.toBe(blockFingerprint(h));
  });
});

// ---------------------------------------------------------------------------
// expandSentinelProvenance
// ---------------------------------------------------------------------------

describe('expandSentinelProvenance', () => {
  it('expands __all__ to per-block entries with baselineText', () => {
    const map: BlockProvenanceMap = { __all__: makeAiEntry() };
    const result = expandSentinelProvenance(map, ['b1', 'b2']);
    expect(result).toEqual({
      b1: makeAiEntry({ baselineText: '' }),
      b2: makeAiEntry({ baselineText: '' }),
    });
  });

  it('sets baselineText to empty string for new AI blocks', () => {
    const map: BlockProvenanceMap = { __all__: makeAiEntry() };
    const result = expandSentinelProvenance(map, ['b1']);
    expect(result!.b1.baselineText).toBe('');
  });

  it('returns map as-is when no __all__', () => {
    const map: BlockProvenanceMap = { b1: makeAiEntry() };
    expect(expandSentinelProvenance(map, ['b1'])).toBe(map);
  });

  it('returns undefined for undefined input', () => {
    expect(expandSentinelProvenance(undefined, ['b1'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordUserEdit
// ---------------------------------------------------------------------------

describe('recordUserEdit', () => {
  it('creates user entry for new block', () => {
    const result = recordUserEdit(undefined, 'b1');
    expect(result.b1.author).toBe('user');
  });

  it('appends modification for AI block', () => {
    const map: BlockProvenanceMap = { b1: makeAiEntry() };
    const result = recordUserEdit(map, 'b1');
    expect(result.b1.author).toBe('ai');
    expect(result.b1.modifications).toHaveLength(1);
    expect(result.b1.modifications![0].by).toBe('user');
  });

  it('is no-op for existing user block', () => {
    const map: BlockProvenanceMap = { b1: makeUserEntry() };
    const result = recordUserEdit(map, 'b1');
    expect(result).toStrictEqual(map);
  });

  it('preserves existing baselineText on AI block', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'original' }),
    };
    const result = recordUserEdit(map, 'b1');
    expect(result.b1.baselineText).toBe('original');
    expect(result.b1.modifications).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// recordUserEdits (batch)
// ---------------------------------------------------------------------------

describe('recordUserEdits', () => {
  it('handles multiple block IDs in a single copy', () => {
    const map: BlockProvenanceMap = { b1: makeAiEntry() };
    const result = recordUserEdits(map, ['b1', 'b2']);
    expect(result.b1.modifications).toHaveLength(1);
    expect(result.b2.author).toBe('user');
  });

  it('returns empty map for empty blockIds on undefined input', () => {
    const result = recordUserEdits(undefined, []);
    expect(result).toEqual({});
  });

  it('is no-op for existing user blocks', () => {
    const map: BlockProvenanceMap = {
      b1: makeUserEntry(),
      b2: makeUserEntry(),
    };
    const result = recordUserEdits(map, ['b1', 'b2']);
    expect(result.b1).toBe(map.b1);
    expect(result.b2).toBe(map.b2);
  });
});

// ---------------------------------------------------------------------------
// getBlockAuthorStatus
// ---------------------------------------------------------------------------

describe('getBlockAuthorStatus', () => {
  it('returns ai for pure AI block', () => {
    expect(getBlockAuthorStatus(makeAiEntry())).toBe('ai');
  });

  it('returns user-modified for AI block with user modifications', () => {
    const entry = makeAiEntry({
      modifications: [{ by: 'user', at: '2025-01-02T00:00:00Z' }],
    });
    expect(getBlockAuthorStatus(entry)).toBe('user-modified');
  });

  it('returns user for user block', () => {
    expect(getBlockAuthorStatus(makeUserEntry())).toBe('user');
  });

  it('returns none for undefined', () => {
    expect(getBlockAuthorStatus(undefined)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// hasAnyPureAiBlock
// ---------------------------------------------------------------------------

describe('hasAnyPureAiBlock', () => {
  it('returns true when a pure AI block exists', () => {
    expect(hasAnyPureAiBlock({ b1: makeAiEntry() })).toBe(true);
  });

  it('returns false when all AI blocks are user-modified', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({
        modifications: [{ by: 'user', at: '2025-01-02T00:00:00Z' }],
      }),
    };
    expect(hasAnyPureAiBlock(map)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasAnyPureAiBlock(undefined)).toBe(false);
  });

  it('ignores __all__ key', () => {
    expect(hasAnyPureAiBlock({ __all__: makeAiEntry() })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeProvenanceAfterAIUpdate
// ---------------------------------------------------------------------------

describe('mergeProvenanceAfterAIUpdate', () => {
  it('carries over provenance for matched blocks (identical content)', () => {
    const oldBlocks = [makeBlock('old1', 'Hello')];
    const newBlocks = [makeBlock('new1', 'Hello')];
    const oldProv: BlockProvenanceMap = { old1: makeUserEntry() };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.new1.author).toBe('user');
    expect(result.old1).toBeUndefined();
  });

  it('carries over existing baselineText for matched blocks', () => {
    const oldBlocks = [makeBlock('old1', 'Hello')];
    const newBlocks = [makeBlock('new1', 'Hello')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry({ baselineText: 'original' }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.new1.baselineText).toBe('original');
  });

  it('sets baselineText on unmatched new blocks from paired old text', () => {
    const oldBlocks = [makeBlock('old1', 'Hello')];
    const newBlocks = [makeBlock('new1', 'Hello World')];
    const oldProv: BlockProvenanceMap = { old1: makeAiEntry() };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.new1.author).toBe('ai');
    expect(result.new1.baselineText).toBe('Hello');
  });

  it('uses cumulative baselineText from old entry when pairing', () => {
    // Simulates: AI edit 1 set baselineText="original", AI edit 2 changes text again
    const oldBlocks = [makeBlock('old1', 'Hello World')];
    const newBlocks = [makeBlock('new1', 'Hello World!')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry({ baselineText: 'original' }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    // Should carry the original baselineText, not the intermediate text
    expect(result.new1.baselineText).toBe('original');
  });

  it('sets empty baselineText for brand-new blocks with no old pair', () => {
    const oldBlocks: ProvenanceBlock[] = [];
    const newBlocks = [makeBlock('new1', 'Brand new')];
    const oldProv: BlockProvenanceMap = {};

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.new1.baselineText).toBe('');
  });

  it('creates __deleted_N__ entries for excess unmatched old blocks', () => {
    const oldBlocks = [
      makeBlock('old1', 'Keep this'),
      makeBlock('old2', 'Delete this'),
    ];
    const newBlocks = [makeBlock('new1', 'Keep this')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry(),
      old2: makeAiEntry(),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.__deleted_0__).toBeDefined();
    expect(result.__deleted_0__.deleted).toBe(true);
    expect(result.__deleted_0__.baselineText).toBe('Delete this');
    expect(result.__deleted_0__.afterBlockId).toBe('new1');
  });

  it('sets afterBlockId to null for deletion at document start', () => {
    const oldBlocks = [
      makeBlock('old1', 'Deleted first'),
      makeBlock('old2', 'Kept'),
    ];
    const newBlocks = [makeBlock('new2', 'Kept')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry(),
      old2: makeAiEntry(),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(result.__deleted_0__).toBeDefined();
    expect(result.__deleted_0__.afterBlockId).toBeNull();
  });

  it('does not create deleted entries for empty-text blocks', () => {
    const oldBlocks = [makeBlock('old1', 'Keep'), makeBlock('old2', '')];
    const newBlocks = [makeBlock('new1', 'Keep')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry(),
      old2: makeAiEntry(),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    expect(
      Object.keys(result).filter((k) => k.startsWith('__deleted_')),
    ).toHaveLength(0);
  });

  it('handles multiple empty paragraphs with same fingerprint', () => {
    const oldBlocks = [makeBlock('old1', ''), makeBlock('old2', '')];
    const newBlocks = [makeBlock('new1', ''), makeBlock('new2', '')];
    const oldProv: BlockProvenanceMap = {
      old1: makeAiEntry(),
      old2: makeUserEntry(),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    // Greedy matching: new1 matches old1 (ai), new2 matches old2 (user)
    expect(result.new1.author).toBe('ai');
    expect(result.new2.author).toBe('user');
  });

  it('preserves existing __deleted_* entries from previous operations', () => {
    // Simulate: first AI edit deleted "Was here", second AI edit modifies content
    const oldBlocks = [makeBlock('cur1', 'Hello'), makeBlock('cur2', 'World')];
    const newBlocks = [
      makeBlock('new1', 'Hello'),
      makeBlock('new2', 'World updated'),
    ];
    const oldProv: BlockProvenanceMap = {
      cur1: makeAiEntry(),
      cur2: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Was here',
        afterBlockId: 'cur1',
      }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    // The old __deleted_0__ should be carried forward with remapped afterBlockId
    const deletedKeys = Object.keys(result).filter((k) =>
      k.startsWith('__deleted_'),
    );
    expect(deletedKeys.length).toBeGreaterThanOrEqual(1);
    const carried = Object.entries(result).find(
      ([, e]) => e.baselineText === 'Was here',
    );
    expect(carried).toBeDefined();
    expect(carried![1].deleted).toBe(true);
    // afterBlockId should be remapped from cur1 to new1
    expect(carried![1].afterBlockId).toBe('new1');
  });

  it('remaps afterBlockId in carried-forward __deleted_* entries', () => {
    const oldBlocks = [makeBlock('a', 'Alpha'), makeBlock('b', 'Beta')];
    const newBlocks = [makeBlock('x', 'Alpha'), makeBlock('y', 'Beta')];
    const oldProv: BlockProvenanceMap = {
      a: makeAiEntry(),
      b: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Gone',
        afterBlockId: 'b',
      }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    const carried = Object.entries(result).find(
      ([, e]) => e.baselineText === 'Gone',
    );
    expect(carried).toBeDefined();
    // afterBlockId 'b' should be remapped to 'y'
    expect(carried![1].afterBlockId).toBe('y');
  });

  it('handles __deleted_* with afterBlockId pointing to a now-deleted block', () => {
    // Scenario: old __deleted_0__ had afterBlockId='b', but 'b' is also deleted
    const oldBlocks = [
      makeBlock('a', 'Alpha'),
      makeBlock('b', 'Beta'),
      makeBlock('c', 'Gamma'),
    ];
    const newBlocks = [makeBlock('x', 'Alpha'), makeBlock('z', 'Gamma')];
    const oldProv: BlockProvenanceMap = {
      a: makeAiEntry(),
      b: makeAiEntry(),
      c: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Previously deleted',
        afterBlockId: 'b',
      }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    const carried = Object.entries(result).find(
      ([, e]) => e.baselineText === 'Previously deleted',
    );
    expect(carried).toBeDefined();
    // 'b' is deleted in this operation, so should fall back to nearest
    // preceding matched block 'a' → 'x'
    expect(carried![1].afterBlockId).toBe('x');
  });

  it('accumulates deletions from multiple sequential operations', () => {
    // First operation deleted "First gone" (stored as __deleted_0__)
    // Second operation deletes "Beta"
    const oldBlocks = [makeBlock('a', 'Alpha'), makeBlock('b', 'Beta')];
    const newBlocks = [makeBlock('x', 'Alpha')];
    const oldProv: BlockProvenanceMap = {
      a: makeAiEntry(),
      b: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'First gone',
        afterBlockId: 'a',
      }),
    };

    const result = mergeProvenanceAfterAIUpdate(
      oldProv,
      oldBlocks,
      newBlocks,
      sentinel,
    );

    const deletedEntries = Object.entries(result).filter(([k]) =>
      k.startsWith('__deleted_'),
    );
    // Should have 2 deletions: "Beta" from this operation + "First gone" carried forward
    expect(deletedEntries).toHaveLength(2);

    const texts = deletedEntries.map(([, e]) => e.baselineText).sort();
    expect(texts).toEqual(['Beta', 'First gone']);
  });
});

// ---------------------------------------------------------------------------
// deriveBlockDiffMap
// ---------------------------------------------------------------------------

describe('deriveBlockDiffMap', () => {
  it('includes AI blocks with baselineText', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'old' }),
      b2: makeAiEntry(),
    };
    const result = deriveBlockDiffMap(map);
    expect(result.size).toBe(1);
    expect(result.get('b1')).toBe('old');
  });

  it('excludes __deleted_* entries', () => {
    const map: BlockProvenanceMap = {
      __deleted_0__: makeAiEntry({
        baselineText: 'del',
        deleted: true,
      }),
      b1: makeAiEntry({ baselineText: 'old' }),
    };
    const result = deriveBlockDiffMap(map);
    expect(result.size).toBe(1);
    expect(result.has('__deleted_0__')).toBe(false);
  });

  it('excludes user-modified blocks', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({
        baselineText: 'old',
        modifications: [{ by: 'user', at: '2025-01-02T00:00:00Z' }],
      }),
    };
    const result = deriveBlockDiffMap(map);
    expect(result.size).toBe(0);
  });

  it('returns empty map for undefined', () => {
    expect(deriveBlockDiffMap(undefined).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveDeletedBlocks
// ---------------------------------------------------------------------------

describe('deriveDeletedBlocks', () => {
  it('returns sorted deleted entries', () => {
    const map: BlockProvenanceMap = {
      __deleted_1__: makeAiEntry({
        deleted: true,
        baselineText: 'second',
        afterBlockId: 'b2',
      }),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'first',
        afterBlockId: null,
      }),
    };
    const result = deriveDeletedBlocks(map);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('first');
    expect(result[1].text).toBe('second');
  });

  it('excludes entries with empty text', () => {
    const map: BlockProvenanceMap = {
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: '   ',
        afterBlockId: null,
      }),
    };
    expect(deriveDeletedBlocks(map)).toHaveLength(0);
  });

  it('returns empty array for undefined', () => {
    expect(deriveDeletedBlocks(undefined)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clearBaselineText
// ---------------------------------------------------------------------------

describe('clearBaselineText', () => {
  it('removes baselineText from specified block', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'old' }),
    };
    const result = clearBaselineText(map, 'b1');
    expect(result.b1.baselineText).toBeUndefined();
    expect(result.b1.author).toBe('ai');
  });

  it('does not affect other blocks', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'old1' }),
      b2: makeAiEntry({ baselineText: 'old2' }),
    };
    const result = clearBaselineText(map, 'b1');
    expect(result.b1.baselineText).toBeUndefined();
    expect(result.b2.baselineText).toBe('old2');
  });

  it('handles missing block gracefully', () => {
    const map: BlockProvenanceMap = { b1: makeAiEntry() };
    const result = clearBaselineText(map, 'b999');
    expect(result).toEqual(map);
  });

  it('returns empty map for undefined input', () => {
    expect(clearBaselineText(undefined, 'b1')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// clearAllBaselines
// ---------------------------------------------------------------------------

describe('clearAllBaselines', () => {
  it('removes all baselineText fields', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'old1' }),
      b2: makeAiEntry({ baselineText: 'old2' }),
    };
    const result = clearAllBaselines(map);
    expect(result.b1.baselineText).toBeUndefined();
    expect(result.b2.baselineText).toBeUndefined();
  });

  it('removes __deleted_* entries', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry(),
      __deleted_0__: makeAiEntry({ deleted: true, baselineText: 'del' }),
    };
    const result = clearAllBaselines(map);
    expect(result.__deleted_0__).toBeUndefined();
    expect(result.b1).toBeDefined();
  });

  it('preserves other provenance data', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({
        baselineText: 'old',
        modifications: [{ by: 'user', at: '2025-01-01T00:00:00Z' }],
      }),
    };
    const result = clearAllBaselines(map);
    expect(result.b1.modifications).toHaveLength(1);
    expect(result.b1.author).toBe('ai');
  });
});

// ---------------------------------------------------------------------------
// removeDeletedEntry
// ---------------------------------------------------------------------------

describe('removeDeletedEntry', () => {
  it('removes the specified deleted entry', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry(),
      __deleted_0__: makeAiEntry({ deleted: true, baselineText: 'del' }),
    };
    const result = removeDeletedEntry(map, '__deleted_0__');
    expect(result.__deleted_0__).toBeUndefined();
    expect(result.b1).toBeDefined();
  });

  it('returns empty map for undefined', () => {
    expect(removeDeletedEntry(undefined, '__deleted_0__')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// hasAnyPendingDiff
// ---------------------------------------------------------------------------

describe('hasAnyPendingDiff', () => {
  it('returns true when a block has baselineText', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry({ baselineText: 'old' }),
    };
    expect(hasAnyPendingDiff(map)).toBe(true);
  });

  it('returns true when __deleted entries exist', () => {
    const map: BlockProvenanceMap = {
      __deleted_0__: makeAiEntry({ deleted: true, baselineText: 'del' }),
    };
    expect(hasAnyPendingDiff(map)).toBe(true);
  });

  it('returns false when no baselines', () => {
    const map: BlockProvenanceMap = { b1: makeAiEntry() };
    expect(hasAnyPendingDiff(map)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasAnyPendingDiff(undefined)).toBe(false);
  });

  it('ignores __all__ key', () => {
    const map: BlockProvenanceMap = {
      __all__: makeAiEntry({ baselineText: 'ignored' }),
    };
    expect(hasAnyPendingDiff(map)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDeletedKeys
// ---------------------------------------------------------------------------

describe('getDeletedKeys', () => {
  it('returns sorted deleted keys', () => {
    const map: BlockProvenanceMap = {
      b1: makeAiEntry(),
      __deleted_2__: makeAiEntry({ deleted: true, baselineText: 'c' }),
      __deleted_0__: makeAiEntry({ deleted: true, baselineText: 'a' }),
      __deleted_1__: makeAiEntry({ deleted: true, baselineText: 'b' }),
    };
    expect(getDeletedKeys(map)).toEqual([
      '__deleted_0__',
      '__deleted_1__',
      '__deleted_2__',
    ]);
  });

  it('returns empty array for undefined', () => {
    expect(getDeletedKeys(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// repairDeletedBlockAnchors
// ---------------------------------------------------------------------------

describe('repairDeletedBlockAnchors', () => {
  it('repairs afterBlockId when anchor block is removed', () => {
    // Previous block order: [a, b, c]
    // Block 'b' (the anchor) was removed; 'a' and 'c' survive
    const map: BlockProvenanceMap = {
      a: makeAiEntry(),
      c: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Gone',
        afterBlockId: 'b',
      }),
    };

    const result = repairDeletedBlockAnchors(map, new Set(['a', 'c']), [
      'a',
      'b',
      'c',
    ]);

    expect(result!.__deleted_0__.afterBlockId).toBe('a');
  });

  it('sets afterBlockId to null when all preceding blocks are removed', () => {
    // Previous order: [a, b, c], anchored after 'a', but 'a' is removed
    const map: BlockProvenanceMap = {
      c: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Gone',
        afterBlockId: 'a',
      }),
    };

    const result = repairDeletedBlockAnchors(map, new Set(['c']), [
      'a',
      'b',
      'c',
    ]);

    expect(result!.__deleted_0__.afterBlockId).toBeNull();
  });

  it('does not modify entries with valid afterBlockId', () => {
    const map: BlockProvenanceMap = {
      a: makeAiEntry(),
      b: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Gone',
        afterBlockId: 'a',
      }),
    };

    const result = repairDeletedBlockAnchors(map, new Set(['a', 'b']), [
      'a',
      'b',
    ]);

    // Should return the same map reference (no repair needed)
    expect(result).toBe(map);
    expect(result!.__deleted_0__.afterBlockId).toBe('a');
  });

  it('does not modify entries with null afterBlockId', () => {
    const map: BlockProvenanceMap = {
      a: makeAiEntry(),
      __deleted_0__: makeAiEntry({
        deleted: true,
        baselineText: 'Gone',
        afterBlockId: null,
      }),
    };

    const result = repairDeletedBlockAnchors(map, new Set(['a']), ['a']);

    expect(result).toBe(map);
  });

  it('returns undefined for undefined input', () => {
    expect(repairDeletedBlockAnchors(undefined, new Set(), [])).toBeUndefined();
  });
});
