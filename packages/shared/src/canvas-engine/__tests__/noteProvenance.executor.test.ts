// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';
import { fingerprintMarkdownKeys } from '../provenance/blockFingerprint.js';

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

  it('accumulates sequential agent rewrites against the last human content', () => {
    const start = note('n1', { content: 'Original human paragraph.' });
    const first = runContentEdit('agent', start, 'First AI rewrite.');
    const firstNode = first.out.writeResult.nodes.find((n) => n.id === 'n1');
    expect(firstNode).toBeDefined();

    const second = runContentEdit(
      'agent',
      firstNode as CanvasNode,
      'Second AI rewrite.',
    );

    expect(second.provenance?.blocks).toHaveLength(1);
    expect(second.provenance?.blocks[0]?.baselineMarkdown).toBe(
      'Original human paragraph.',
    );
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

  it.each([
    {
      name: 'the exact human text',
      original: 'Original human paragraph.',
      restored: 'Original human paragraph.',
    },
    {
      name: 'equivalent list markers',
      original: '* alpha\n* beta',
      restored: '- alpha\n- beta',
    },
    {
      name: 'equivalent math delimiters',
      original: String.raw`The result is \(x + y\).`,
      restored: 'The result is $x + y$.',
    },
    {
      name: 'equivalent reference-style links',
      original: 'Read [the guide](https://example.com "Docs").',
      restored:
        'Read [the guide][guide].\n\n[guide]: https://example.com "Docs"',
    },
  ])(
    'clears the pending modification when AI restores $name',
    ({ original, restored }) => {
      const first = runContentEdit(
        'agent',
        note('n1', { content: original }),
        'AI rewrite.',
      );
      const firstNode = first.out.writeResult.nodes[0];
      expect(first.provenance?.blocks).toHaveLength(1);

      const second = runContentEdit('agent', firstNode, restored);

      expect(second.provenance).toEqual({
        version: 1,
        blocks: [],
        deletedBlocks: [],
      });
      expect(second.out.writeResult.nodes[0].data.content).toBe(restored);
      // Clearing a current marker does not mutate an earlier execution result.
      expect(first.provenance?.blocks).toHaveLength(1);
      expect(firstNode.data.content).toBe('AI rewrite.');
    },
  );

  it.each([
    {
      name: 'reference link',
      original:
        'Read [the guide][guide].\n\n[guide]: https://example.com "Docs"',
      inline: 'Read [the guide](https://example.com "Docs").',
    },
    {
      name: 'reference image',
      original:
        '![Diagram][diagram]\n\n[diagram]: artifacts/diagram.png "Architecture"',
      inline: '![Diagram](artifacts/diagram.png "Architecture")',
    },
  ])(
    'retains a $name baseline through serialized sequential edits',
    ({ original, inline }) => {
      const first = runContentEdit(
        'agent',
        note('n1', { content: original }),
        'First AI rewrite.',
      );
      const firstNode = JSON.parse(
        JSON.stringify(first.out.writeResult.nodes[0]),
      ) as CanvasNode;
      const second = runContentEdit('agent', firstNode, 'Second AI rewrite.');
      const secondNode = JSON.parse(
        JSON.stringify(second.out.writeResult.nodes[0]),
      ) as CanvasNode;
      const baselineKey = fingerprintMarkdownKeys(original)[0];
      expect(first.provenance?.blocks[0]?.baselineKey).toBe(baselineKey);
      expect(second.provenance?.blocks[0]?.baselineKey).toBe(baselineKey);

      for (const restored of [original, inline]) {
        const result = runContentEdit('agent', secondNode, restored);
        expect(result.provenance).toEqual({
          version: 1,
          blocks: [],
          deletedBlocks: [],
        });
        expect(result.out.writeResult.nodes[0].data.content).toBe(restored);
      }
      // The same visible reference text with a different target is not a restoration.
      const changedTarget = original
        .replace('example.com', 'other.example')
        .replace('diagram.png', 'other.png');
      const changed = runContentEdit('agent', secondNode, changedTarget);
      expect(changed.provenance?.blocks).toHaveLength(1);
      expect(first.provenance?.blocks).toHaveLength(1);
      expect(second.provenance?.blocks).toHaveLength(1);
    },
  );

  it('restores a duplicate reference block using its original canonical identity', () => {
    const original =
      'Read [guide][g].\n\nSeparator.\n\nRead [guide][g].\n\n[g]: https://example.com';
    const first = runContentEdit(
      'agent',
      note('n1', { content: original }),
      'Read [guide][g].\n\nSeparator.\n\nAI rewrite.\n\n[g]: https://example.com',
    );
    expect(fingerprintMarkdownKeys(original)[2]).toMatch(/#2$/);

    const restored = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      original,
    );

    expect(first.provenance?.blocks[0]?.baselineKey).toBe(
      fingerprintMarkdownKeys(original)[0],
    );
    expect(restored.provenance?.blocks).toEqual([]);
  });

  it('keeps legacy records without a baseline key compatible across rewrites', () => {
    const original = '* alpha\n* beta';
    const legacy: MarkdownProvenance = {
      version: 1,
      blocks: [
        {
          key: fingerprintMarkdownKeys('First AI rewrite.')[0],
          baselineMarkdown: original,
          at: '2026-09-14T00:00:00.000Z',
        },
      ],
      deletedBlocks: [],
    };
    const second = runContentEdit(
      'agent',
      note('n1', { content: 'First AI rewrite.', provenance: legacy }),
      'Second AI rewrite.',
    );
    const restored = runContentEdit(
      'agent',
      second.out.writeResult.nodes[0],
      '- alpha\n- beta',
    );

    expect(second.provenance?.blocks[0]?.baselineMarkdown).toBe(original);
    expect(second.provenance?.blocks[0]?.baselineKey).toBeUndefined();
    expect(restored.provenance?.blocks).toEqual([]);
    expect(legacy.blocks).toHaveLength(1);
  });

  it('does not invent a canonical baseline for a legacy reference fragment', () => {
    const legacy: MarkdownProvenance = {
      version: 1,
      blocks: [
        {
          key: fingerprintMarkdownKeys('First AI rewrite.')[0],
          kind: 'modified',
          baselineMarkdown: 'Read [guide][g].',
          at: '2026-09-14T00:00:00.000Z',
        },
      ],
      deletedBlocks: [],
    };
    const first = runContentEdit(
      'agent',
      note('n1', { content: 'First AI rewrite.', provenance: legacy }),
      'Read [guide][g].\n\n[g]: https://example.com',
    );
    const second = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      'Another rewrite.',
    );
    const third = runContentEdit(
      'agent',
      second.out.writeResult.nodes[0],
      'Read [guide][g].\n\n[g]: https://other.example',
    );

    // The missing historical target is unknown; a current definition is not evidence.
    expect(third.provenance?.blocks).toHaveLength(1);
    expect(third.provenance?.blocks[0]?.baselineKey).toBeUndefined();
    expect(third.provenance?.blocks[0]?.baselineMarkdown).toBe(
      'Read [guide][g].',
    );
  });

  it('clears a restored duplicate block despite its occurrence suffix', () => {
    const original = 'Repeated paragraph.\n\nSeparator.\n\nRepeated paragraph.';
    const first = runContentEdit(
      'agent',
      note('n1', { content: original }),
      'Repeated paragraph.\n\nSeparator.\n\nAI rewrite.',
    );
    expect(fingerprintMarkdownKeys(original)[2]).toMatch(/#2$/);

    const second = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      original,
    );

    expect(second.provenance?.blocks).toEqual([]);
    expect(second.provenance?.deletedBlocks).toEqual([]);
  });

  it('preserves other pending edits and tombstones when one block is restored', () => {
    const original =
      'Human first.\n\nSeparator.\n\nHuman second.\n\nDeleted paragraph.';
    const first = runContentEdit(
      'agent',
      note('n1', { content: original }),
      'AI first.\n\nSeparator.\n\nHuman second.',
    );
    const second = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      'AI first.\n\nSeparator.\n\nAI second.',
    );
    const finalContent = 'AI first.\n\nSeparator.\n\nHuman second.';
    const third = runContentEdit(
      'agent',
      second.out.writeResult.nodes[0],
      finalContent,
    );

    expect(third.provenance?.blocks).toEqual([first.provenance?.blocks[0]]);
    expect(third.provenance?.deletedBlocks).toEqual(
      first.provenance?.deletedBlocks,
    );
    expect(third.provenance?.deletedBlocks).toHaveLength(1);
  });

  it('starts a fresh pending modification after an earlier edit was fully restored', () => {
    const original = 'Original human paragraph.';
    const first = runContentEdit(
      'agent',
      note('n1', { content: original }),
      'AI rewrite.',
    );
    const restored = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      original,
    );
    const next = runContentEdit(
      'agent',
      restored.out.writeResult.nodes[0],
      'Another AI rewrite.',
    );

    expect(restored.provenance?.blocks).toEqual([]);
    expect(next.provenance?.blocks).toHaveLength(1);
    expect(next.provenance?.blocks[0]).toMatchObject({
      kind: 'modified',
      baselineMarkdown: original,
    });
  });

  it('keeps a rewritten AI insertion pending when it duplicates human text', () => {
    const first = runContentEdit(
      'agent',
      note('n1', { content: 'Human paragraph.' }),
      'Human paragraph.\n\nAI insertion.',
    );
    const finalContent = 'Human paragraph.\n\nHuman paragraph.';
    const second = runContentEdit(
      'agent',
      first.out.writeResult.nodes[0],
      finalContent,
    );

    expect(second.provenance?.blocks).toEqual([
      {
        ...first.provenance?.blocks[0],
        key: fingerprintMarkdownKeys(finalContent)[1],
      },
    ]);
    expect(second.provenance?.blocks[0]?.kind).toBe('inserted');
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

  it('canonicalizes reference links to the same visible block as Milkdown', () => {
    const reference =
      'Read [the guide][guide].\n\n[guide]: https://example.com "Docs"';
    const inline = 'Read [the guide](https://example.com "Docs").';

    expect(fingerprintMarkdownKeys(reference)).toEqual(
      fingerprintMarkdownKeys(inline),
    );

    const start = note('n1', { content: 'Read the old guide.' });
    const { provenance } = runContentEdit('agent', start, reference);
    expect(provenance?.blocks).toHaveLength(1);
    expect(provenance?.blocks[0]?.key).toBe(fingerprintMarkdownKeys(inline)[0]);
  });

  it('canonicalizes reference images to the same visible block as Milkdown', () => {
    const reference =
      '![Diagram][diagram]\n\n[diagram]: artifacts/diagram.png "Architecture"';
    const inline = '![Diagram](artifacts/diagram.png "Architecture")';

    expect(fingerprintMarkdownKeys(reference)).toEqual(
      fingerprintMarkdownKeys(inline),
    );
  });

  it('canonicalizes LaTeX-style inline math before stamping provenance', () => {
    const latexDelimiters = String.raw`The result is \(x + y\).`;
    const milkdownDelimiters = 'The result is $x + y$.';

    expect(fingerprintMarkdownKeys(latexDelimiters)).toEqual(
      fingerprintMarkdownKeys(milkdownDelimiters),
    );

    const start = note('n1', { content: 'The old result.' });
    const { provenance } = runContentEdit('agent', start, latexDelimiters);
    expect(provenance?.blocks).toHaveLength(1);
    expect(provenance?.blocks[0]?.key).toBe(
      fingerprintMarkdownKeys(milkdownDelimiters)[0],
    );
  });

  it('canonicalizes LaTeX-style display math to Milkdown block math', () => {
    const latexDelimiters = String.raw`\[x^2 + y^2 = z^2\]`;
    const milkdownDelimiters = '$$\nx^2 + y^2 = z^2\n$$';

    expect(fingerprintMarkdownKeys(latexDelimiters)).toEqual(
      fingerprintMarkdownKeys(milkdownDelimiters),
    );
  });
});
