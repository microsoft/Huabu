// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type {
  CanvasExecutionSource,
  CanvasCommand,
} from '../../types/canvas/index.js';
import type { MarkdownProvenance } from '../../types/canvas/node.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function note(id: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id, type: 'note', position: { x: 0, y: 0 }, data } as CanvasNode;
}

function runContentEdit(
  source: CanvasExecutionSource,
  start: CanvasNode,
  newContent: string,
) {
  const command: CanvasCommand = {
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: start.id as never, patch: { content: newContent } }],
  };
  const out = executeCanvasCommands(
    { source, commands: [command] },
    { nodes: [start], edges: [] as CanvasEdge[], canvasId: 'c1' },
  );
  const node = out.writeResult.nodes.find((n) => n.id === start.id);
  const provenance = (node?.data as { provenance?: MarkdownProvenance })
    ?.provenance;
  return { out, provenance };
}

describe('executeCanvasCommands: AI note provenance', () => {
  it('stamps block provenance for an agent content rewrite', () => {
    const start = note('n1', { content: '# Title\n\nOriginal paragraph.' });
    const { provenance } = runContentEdit(
      'agent',
      start,
      '# Title\n\nRewritten paragraph by AI.',
    );

    const blocks = provenance?.blocks ?? [];
    // The heading is unchanged (no entry); the paragraph was modified.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('modified');
    expect(blocks[0].baselineMarkdown).toBe('Original paragraph.');
  });

  it('marks a brand-new appended block as inserted', () => {
    const start = note('n1', { content: 'Kept paragraph.' });
    const { provenance } = runContentEdit(
      'agent',
      start,
      'Kept paragraph.\n\nBrand new AI line.',
    );

    const blocks = provenance?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('inserted');
    expect(blocks[0].baselineMarkdown).toBe('');
  });

  it('does NOT stamp provenance for a user (ui) content edit', () => {
    const start = note('n1', { content: 'Original paragraph.' });
    const { provenance } = runContentEdit(
      'ui',
      start,
      'User-edited paragraph.',
    );
    expect(provenance).toBeUndefined();
  });

  it('key parity: pure marker renormalization produces no spurious stamps', () => {
    // Old uses `*` bullets, new uses `-`; the items are identical. Because
    // keys come from normalized mdast (marker style stripped), the block is
    // unchanged and nothing is stamped — this is the whole reason server
    // (raw) and client (Milkdown-normalized) markdown agree.
    const start = note('n1', { content: '* alpha\n* beta\n* gamma' });
    const { provenance } = runContentEdit(
      'agent',
      start,
      '- alpha\n- beta\n- gamma',
    );
    expect(provenance?.blocks ?? []).toHaveLength(0);
    expect(provenance?.deletedBlocks ?? []).toHaveLength(0);
  });
});
