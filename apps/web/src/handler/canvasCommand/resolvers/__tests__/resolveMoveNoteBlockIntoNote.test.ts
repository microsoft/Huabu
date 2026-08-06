// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Verifies `resolveMoveNoteBlockIntoNote`:
 *  - emits a single MERGE_NODE_DATA carrying both source + target
 *    patches (atomic undo entry),
 *  - drops the source patch when the snapshot matches current
 *    content (no-op short-circuit),
 *  - degrades gracefully when the source or target node is gone /
 *    no longer a note.
 */

import { describe, expect, it } from 'vitest';

import { resolveUiIntent, type UiResolverState } from '../../uiIntent';

import type { Node } from '@xyflow/react';

function makeUi(nodes: Node[]): UiResolverState {
  return { nodes, edges: [] };
}

function note(id: string, content: string): Node {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content },
  };
}

describe('resolveMoveNoteBlockIntoNote', () => {
  it('emits one MERGE_NODE_DATA with both patches', () => {
    const nodes = [note('a', 'one\n\ntwo'), note('b', 'BBB')];
    const res = resolveUiIntent(
      {
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId: 'a',
        sourceContentAfterMove: 'one',
        targetNodeId: 'b',
        targetContentAfterInsert: 'BBB\n\ntwo',
      },
      makeUi(nodes),
    );

    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toEqual({
      type: 'MERGE_NODE_DATA',
      patches: [
        { nodeId: 'a', patch: { content: 'one' } },
        { nodeId: 'b', patch: { content: 'BBB\n\ntwo' } },
      ],
    });
    expect(res.trace).toEqual([]);
  });

  it('omits the source patch when its snapshot already matches', () => {
    // The source has already roundtripped through onChange and now
    // matches `sourceContentAfterMove`. The resolver should skip its
    // patch but still emit the target patch.
    const nodes = [note('a', 'one'), note('b', 'BBB')];
    const res = resolveUiIntent(
      {
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId: 'a',
        sourceContentAfterMove: 'one',
        targetNodeId: 'b',
        targetContentAfterInsert: 'BBB\n\ntwo',
      },
      makeUi(nodes),
    );

    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toEqual({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'b', patch: { content: 'BBB\n\ntwo' } }],
    });
  });

  it('omits the source patch when the source node has disappeared', () => {
    const nodes = [note('b', 'BBB')];
    const res = resolveUiIntent(
      {
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId: 'ghost',
        sourceContentAfterMove: 'one',
        targetNodeId: 'b',
        targetContentAfterInsert: 'BBB\n\ntwo',
      },
      makeUi(nodes),
    );

    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toEqual({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'b', patch: { content: 'BBB\n\ntwo' } }],
    });
  });

  it('omits the source patch when the source is no longer a note', () => {
    const nodes: Node[] = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} },
      note('b', 'BBB'),
    ];
    const res = resolveUiIntent(
      {
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId: 'a',
        sourceContentAfterMove: 'one',
        targetNodeId: 'b',
        targetContentAfterInsert: 'BBB\n\ntwo',
      },
      makeUi(nodes),
    );

    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toEqual({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'b', patch: { content: 'BBB\n\ntwo' } }],
    });
  });

  it('returns no commands when both source and target are missing', () => {
    const res = resolveUiIntent(
      {
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId: 'ghost-a',
        sourceContentAfterMove: 'one',
        targetNodeId: 'ghost-b',
        targetContentAfterInsert: 'BBB\n\ntwo',
      },
      makeUi([]),
    );

    expect(res.commands).toEqual([]);
    expect(res.trace).toEqual([]);
  });
});
