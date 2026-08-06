// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the deterministic preprocessor.
 *
 * Lock the canonical AgentInput shape produced by the ACP host adapter.
 * Backend lowering and initial-preamble realization are tested in
 * @agenetes/acp-driver.
 */

import { describe, expect, it, vi } from 'vitest';

import { renderExternalAgentInputs } from './preprocessor.js';
import { buildAgentNodePreview, buildAgentNodeRef } from '../node-ref.js';

import type { NodeNeighbourhoodContext } from '../../canvas/node-neighbourhood.js';
import type { ChatEnvelope } from '../conversation/envelope.js';
import type { AgentInput, AgentInputPart } from '@agenetes/protocol';
import type { CanvasNodeType, ChatAttachment } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

/** Minimal logger stub — only `debug` is exercised. */
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

/**
 * Build a minimal {@link ChatEnvelope} for preprocessor tests. Only the
 * fields the ACP serializer reads (`user.text`, `focus.selection.refs`,
 * `preamble.neighbourhood`) carry meaningful values; the rest are
 * inert defaults so the envelope type-checks.
 */
function makeEnvelope(opts: {
  text: string;
  selection?: { id: string; type: CanvasNodeType; label?: string }[];
  neighbourhood?: NodeNeighbourhoodContext;
  attachments?: ChatAttachment[];
}): ChatEnvelope {
  return {
    user: { text: opts.text, attachments: opts.attachments ?? [] },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      selection: {
        refs: (opts.selection ?? []).map((n) =>
          buildAgentNodeRef({ id: n.id, type: n.type, label: n.label }),
        ),
        selectedIds: (opts.selection ?? []).map((n) => n.id),
        imageAttachments: [],
        snapshotAttachments: [],
      },
      ...(opts.neighbourhood
        ? { anchor: { nodeId: 'anchor', neighbourhood: opts.neighbourhood } }
        : {}),
    },
  };
}

function flattenForAssertions(inputs: readonly AgentInput[]): AgentInputPart[] {
  return inputs.flatMap((input) => {
    if (input.type === 'text') return [{ type: 'text', text: input.text }];
    if (input.type === 'parts') return input.parts;
    return [{ type: 'text', text: input.text }, ...input.context];
  });
}

async function renderExternalForAssertions(input: {
  envelope: ChatEnvelope;
  agentAlias: string;
  canvasId?: string | null;
  logger: FastifyBaseLogger;
}) {
  const blocks = flattenForAssertions(await renderExternalAgentInputs(input));
  return {
    serialized: blocks
      .filter(
        (part): part is Extract<AgentInputPart, { type: 'text' }> =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('\n'),
    blocks,
  };
}

describe('renderExternalAgentInputs', () => {
  it('emits the verbatim task and no selected-nodes section when nothing is selected', async () => {
    const { serialized } = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'Explain the difference between async iterators and generators.',
      }),
      agentAlias: 'claude',
      logger,
    });

    // No context sections → bare task, no XML scaffolding (mirrors the
    // built-in plain-text fast path).
    expect(serialized).toBe(
      'Explain the difference between async iterators and generators.',
    );
    expect(serialized).not.toContain('<selected_nodes>');
  });

  it('wraps a selected-nodes list in <selected_nodes> when nodes are present', async () => {
    const { serialized } = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'Compare these notes.',
        selection: [
          { id: 'node-a', type: 'note', label: 'Intro' },
          { id: 'node-b', type: 'image' },
        ],
      }),
      agentAlias: 'claude',
      logger,
    });

    expect(serialized).toContain('<selected_nodes>');
    expect(serialized).toContain('</selected_nodes>');
    expect(serialized).toContain(
      '<node id="node-a" type="note" label="Intro" file="nodes/Intro.md" />',
    );
    // Label-less node renders with id + type + file.
    expect(serialized).toContain(
      '<node id="node-b" type="image" file="nodes/node-b.md" />',
    );
    // The user's words come last, wrapped in <user_request>.
    expect(serialized).toContain(
      '<user_request>\nCompare these notes.\n</user_request>',
    );
    expect(serialized.indexOf('<selected_nodes>')).toBeLessThan(
      serialized.indexOf('<user_request>'),
    );
  });

  it('mentions RFS download in the selected-nodes intro', async () => {
    const { serialized } = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'task',
        selection: [{ id: 'n1', type: 'note' }],
      }),
      agentAlias: 'claude',
      logger,
    });
    expect(serialized).toContain('${HUABU_RFS_URL}/download/');
  });

  it('escapes XML-special characters in labels so the attribute cannot break', async () => {
    const { serialized } = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'task',
        selection: [{ id: 'n1', type: 'note', label: 'a " <b>' }],
      }),
      agentAlias: 'claude',
      logger,
    });
    expect(serialized).toContain(
      '<node id="n1" type="note" label="a &quot; &lt;b&gt;" file="nodes/a _ _b_.md" />',
    );
  });
  it('wraps off-canvas attachments in <attachments> before the user request', async () => {
    const { serialized } = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'summarize the attached note',
        attachments: [
          {
            type: 'text',
            source: 'upload',
            label: 'excerpt',
            content: 'the quick brown fox',
          },
          {
            type: 'web',
            source: 'upload',
            label: 'FX outlook',
            url: 'https://example.com/fx',
            content: 'continued volatility into Q4',
          },
        ],
      }),
      agentAlias: 'claude',
      logger,
    });

    expect(serialized).toContain('<attachments>');
    expect(serialized).toContain('</attachments>');
    expect(serialized).toContain('<attachment type="text">');
    expect(serialized).toContain('the quick brown fox');
    expect(serialized).toContain(
      '<attachment type="web" name="FX outlook" url="https://example.com/fx">',
    );
    // The user's words still come last.
    expect(serialized.indexOf('<attachments>')).toBeLessThan(
      serialized.indexOf('<user_request>'),
    );
  });
});

describe('canonical ACP rendering', () => {
  it('renders ordinary input and slash commands into canonical members', async () => {
    await expect(
      renderExternalAgentInputs({
        envelope: makeEnvelope({ text: 'hello' }),
        agentAlias: 'claude',
        logger,
      }),
    ).resolves.toEqual([{ type: 'text', text: 'hello' }]);

    await expect(
      renderExternalAgentInputs({
        envelope: makeEnvelope({
          text: '/compact now',
          selection: [{ id: 'n1', type: 'note' }],
        }),
        agentAlias: 'claude',
        logger,
      }),
    ).resolves.toMatchObject([
      {
        type: 'command',
        text: '/compact now',
        context: [{ type: 'text' }],
      },
    ]);
  });

  it('forwards slash commands verbatim', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({ text: '/compact please' }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized).toBe('/compact please');
  });

  it('builds selectedNodes from the envelope selection refs', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'do something',
        selection: [
          { id: 'frame-1', type: 'frame', label: 'Group' },
          { id: 'child-1', type: 'note', label: 'Child' },
        ],
      }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized).toContain('do something');
    expect(result.serialized).toContain(
      '<node id="child-1" type="note" label="Child" file="nodes/Child.md" />',
    );
  });

  it('renders a canvas-neighbourhood section when the envelope carries one', async () => {
    const neighbourhood: NodeNeighbourhoodContext = {
      layers: [
        {
          groups: [
            {
              dx: -200,
              dy: 0,
              arrangement: '2 nodes',
              _minEdgeDist: 40,
              nodes: [
                buildAgentNodePreview({
                  id: 'sketch-a',
                  type: 'sketch',
                  label: 'Sketch A',
                }),
              ],
            },
          ],
        },
      ],
      relevantEdges: [],
    };

    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({ text: 'generate an image', neighbourhood }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized).toContain('<canvas_neighbourhood>');
    expect(result.serialized).toContain(
      '<group direction="to the left" arrangement="2 nodes">',
    );
    // ACP now emits `file=` too (RFS downloads by file path).
    expect(result.serialized).toContain(
      '<node id="sketch-a" type="sketch" label="Sketch A" file="nodes/Sketch A.md" />',
    );
    // The user's request comes LAST; the neighbourhood precedes it.
    expect(result.serialized.indexOf('<canvas_neighbourhood>')).toBeLessThan(
      result.serialized.indexOf('generate an image'),
    );
  });

  it('omits the canvas-neighbourhood section when the envelope has none', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({ text: 'plain request' }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized).not.toContain('<canvas_neighbourhood>');
  });

  it('appends neighbourhood context after the slash command', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: '/compact now',
        neighbourhood: {
          layers: [
            {
              groups: [
                {
                  dx: 0,
                  dy: -100,
                  arrangement: 'single node',
                  _minEdgeDist: 5,
                  nodes: [buildAgentNodePreview({ id: 'x', type: 'note' })],
                },
              ],
            },
          ],
          relevantEdges: [],
        },
      }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized.startsWith('/compact now')).toBe(true);
    expect(result.serialized).toContain('<canvas_neighbourhood>');
  });

  it('forwards off-canvas text uploads into the prompt attachments', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'use the attached excerpt',
        attachments: [
          {
            type: 'text',
            source: 'upload',
            label: 'excerpt',
            content: 'Q3 exposure rose 12% on fx volatility.',
          },
        ],
      }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.serialized).toContain('<attachments>');
    expect(result.serialized).toContain(
      'Q3 exposure rose 12% on fx volatility.',
    );
  });

  it('drops a content-less image upload from the wire (no resolvable bytes)', async () => {
    const result = await renderExternalForAssertions({
      envelope: makeEnvelope({
        text: 'look at this',
        attachments: [
          {
            type: 'image',
            source: 'upload',
            label: 'diagram.png',
            url: 'blob:abc',
          },
        ],
      }),
      agentAlias: 'claude',
      logger,
    });

    // No resolvable bytes for a blob: url, so no wire image block.
    expect(result.blocks.some((b) => b.type === 'image')).toBe(false);
  });
});
