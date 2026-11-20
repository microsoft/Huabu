// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import {
  executeCanvasCommands,
  readPaintKey,
  seedNodeOrder,
} from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { type, ...data },
  } as CanvasNode;
}

function merge(
  nodes: CanvasNode[],
  patches: Array<{
    nodeId: string;
    patch: Record<string, unknown>;
    unset?: string[];
  }>,
  source: 'ui' | 'agent' = 'ui',
) {
  return executeCanvasCommands(
    {
      source,
      commands: [
        { type: 'MERGE_NODE_DATA', patches } as unknown as CanvasCommand,
      ],
    },
    { nodes, edges: [], canvasId: 'c1' },
  );
}

describe('MERGE_NODE_DATA unset', () => {
  it('removes a data key and leaves the others', () => {
    const before = seedNodeOrder([
      node('a', 'pdf', { coverPage: 3, pageCount: 9 }),
    ]);
    const { commandResults, writeResult } = merge(before, [
      { nodeId: 'a', patch: {}, unset: ['coverPage'] },
    ]);
    expect(commandResults[0].applied).toBe(true);
    expect(writeResult.nodes[0].data).toEqual({
      type: 'pdf',
      pageCount: 9,
      paintKey: readPaintKey(before[0]),
    });
  });

  it('applies the patch first, then the removal', () => {
    const before = seedNodeOrder([node('a', 'pdf', { coverPage: 3 })]);
    const { writeResult } = merge(before, [
      { nodeId: 'a', patch: { pageCount: 2 }, unset: ['coverPage'] },
    ]);
    expect(writeResult.nodes[0].data).toEqual({
      type: 'pdf',
      pageCount: 2,
      paintKey: readPaintKey(before[0]),
    });
  });

  it('removes one style leaf and drops an emptied style bag', () => {
    const one = merge(
      [node('a', 'note', { style: { accent: 'red', fontSize: 14 } })],
      [{ nodeId: 'a', patch: {}, unset: ['style.accent'] }],
    );
    expect(one.writeResult.nodes[0].data.style).toEqual({ fontSize: 14 });

    const last = merge(
      [node('a', 'note', { style: { accent: 'red' } })],
      [{ nodeId: 'a', patch: {}, unset: ['style.accent'] }],
    );
    expect('style' in last.writeResult.nodes[0].data).toBe(false);
  });

  it('is a no-op on the stored node when the key is already absent', () => {
    const before = seedNodeOrder([
      node('a', 'note', { style: { accent: 'red' } }),
    ]);
    const { writeResult } = merge(before, [
      { nodeId: 'a', patch: {}, unset: ['missing', 'style.missing'] },
    ]);
    expect(writeResult.nodes[0].data).toEqual(before[0].data);
  });

  it('refuses to remove data an Agent Node owns', () => {
    const { commandResults, writeResult } = merge(
      [node('q', 'question', { threadId: 'thread-1', status: 'idle' })],
      [{ nodeId: 'q', patch: {}, unset: ['threadId'] }],
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-target',
    });
    expect(writeResult.nodes[0].data.threadId).toBe('thread-1');
  });

  it('refuses to remove a file reference', () => {
    const { commandResults } = merge(
      [node('f', 'fileReference', { fileReference: { path: 'a.txt' } })],
      [{ nodeId: 'f', patch: {}, unset: ['fileReference'] }],
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-target',
    });
  });

  it('is refused for an agent batch, which clears with null where a field allows it', () => {
    const before = [node('a', 'pdf', { coverPage: 3 })];
    const { commandResults, writeResult } = merge(
      before,
      [{ nodeId: 'a', patch: {}, unset: ['coverPage'] }],
      'agent',
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-scope',
    });
    expect(writeResult.nodes).toBe(before);
  });
});
