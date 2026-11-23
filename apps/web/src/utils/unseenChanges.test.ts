// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  markTouches,
  seenKey,
  threadSeenKeys,
  unseenMarks,
} from './unseenChanges';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

const record = (patch: Partial<CanvasChangeRecord>): CanvasChangeRecord => ({
  id: 'change-1',
  kind: 'create',
  label: 'Created: Plan',
  nodeId: 'n1',
  revertDeltas: [],
  appliedFingerprint: 'f1',
  fingerprintKeys: ['content'],
  ...patch,
});

describe('unseenMarks', () => {
  it('marks nodes an Agent made or changed, not moves, deletions or edges', () => {
    const marks = unseenMarks(
      {
        t1: [
          record({}),
          record({ id: 'c2', kind: 'update', nodeId: 'n2' }),
          record({
            id: 'c3',
            kind: 'update',
            nodeId: 'n3',
            fingerprintKeys: [],
          }),
          record({ id: 'c4', kind: 'delete', nodeId: 'n4' }),
          record({ id: 'c5', kind: 'connect', nodeId: undefined }),
        ],
      },
      {},
    );
    expect([...marks.keys()]).toEqual(['n1', 'n2']);
    expect(marks.get('n1')).toEqual({
      sources: [{ threadId: 't1', kind: 'create', keys: ['change-1@f1'] }],
    });
    expect(marks.get('n2')?.sources[0]?.kind).toBe('update');
  });

  it('leaves out what was seen, until the node is changed again', () => {
    const first = record({});
    const seen = { t1: [seenKey(first)] };
    expect(unseenMarks({ t1: [first] }, seen).size).toBe(0);
    // The record keeps its id when a later change is folded into it.
    const again = record({ appliedFingerprint: 'f2' });
    expect([...unseenMarks({ t1: [again] }, seen).keys()]).toEqual(['n1']);
    // Seeing is per conversation.
    expect(unseenMarks({ t2: [first] }, seen).size).toBe(1);
  });

  it('keeps each conversation that touched a node as its own source', () => {
    const byThread = {
      t1: [record({ id: 'c1', kind: 'update' })],
      t2: [record({ id: 'c2' })],
    };
    const mark = unseenMarks(byThread, {}).get('n1');
    expect(mark).toEqual({
      sources: [
        { threadId: 't1', kind: 'update', keys: ['c1@f1'] },
        { threadId: 't2', kind: 'create', keys: ['c2@f1'] },
      ],
    });
    expect(mark && markTouches(mark, 't2')).toBe(true);
    expect(mark && markTouches(mark, 't3')).toBe(false);
    // Seeing one conversation's part leaves the other's.
    expect(unseenMarks(byThread, { t1: ['c1@f1'] }).get('n1')?.sources).toEqual(
      [{ threadId: 't2', kind: 'create', keys: ['c2@f1'] }],
    );
  });
});

describe('threadSeenKeys', () => {
  it('names the keys of the records that can be marked', () => {
    expect(
      threadSeenKeys([record({}), record({ id: 'c4', kind: 'delete' })]),
    ).toEqual(['change-1@f1']);
    expect(threadSeenKeys(undefined)).toEqual([]);
  });
});
