// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the per-turn render seam.
 *
 * Locks the structured-message assembly that both the built-in agent and
 * the history-reload path depend on:
 *   - one turn collapses to a SINGLE user message (was up to four);
 *   - context sections are XML-tagged and ordered
 *     (`<invoked_skills>` → `<selected_nodes>` → `<canvas_neighbourhood>`);
 *   - the user's own words always come LAST, wrapped in `<user_request>`;
 *   - the plain-text fast path skips the XML scaffolding entirely;
 *   - `rebuildContextMessages` replays the canonical `rendered` inputs a
 *     turn was submitted with, and only re-derives from the stored
 *     envelope for records written before `rendered` existed.
 */

import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { describe, expect, it } from 'vitest';

import {
  renderEnvelopeMessages,
  rebuildContextMessages,
} from './build-prompt.js';
import { createChatSubmission } from '../../agenetes/handle.js';
import { buildAgentNodePreview } from '../../node-ref.js';

import type { NodeNeighbourhoodContext } from '../../../canvas/node-neighbourhood.js';
import type { AgentNodeRef } from '../../node-ref.js';
import type { ChatEnvelope, ResolvedSkill } from '../envelope.js';
import type {
  AgentInputPart,
  AgentTurn,
  FoldedMessage,
} from '@agenetes/protocol';
import type { Api, Context, Message, Model } from '@earendil-works/pi-ai';
import type { ChatAttachment } from '@huabu/shared';

/** Build an {@link AgentTurn} from an envelope + folded transcript. */
function makeTurn(
  envelope: ChatEnvelope,
  transcript: FoldedMessage[],
): AgentTurn {
  return { request: createChatSubmission(envelope), transcript };
}

// ─── Fixtures ────────────────────────────────────────────────────────────

function makeEnvelope(over: {
  text?: string;
  attachments?: ChatAttachment[];
  refs?: AgentNodeRef[];
  neighbourhood?: NodeNeighbourhoodContext;
  resolvedSkills?: ResolvedSkill[];
  imageAttachments?: ChatAttachment[];
  snapshotAttachments?: ChatAttachment[];
}): ChatEnvelope {
  return {
    user: { text: over.text ?? '', attachments: over.attachments ?? [] },
    skills: {
      invokedIds: (over.resolvedSkills ?? []).map((s) => s.id),
      resolved: over.resolvedSkills ?? [],
    },
    focus: {
      selection: {
        refs: over.refs ?? [],
        selectedIds: (over.refs ?? []).map((r) => r.id),
        imageAttachments: over.imageAttachments ?? [],
        snapshotAttachments: over.snapshotAttachments ?? [],
      },
      ...(over.neighbourhood
        ? { anchor: { nodeId: 'anchor', neighbourhood: over.neighbourhood } }
        : {}),
    },
  };
}

/** Flatten a message's content to a single string for assertions. */
function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

const NO_CANVAS = { canvasId: null };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('renderEnvelopeMessages', () => {
  it('renders plain text as a single string-content message (no XML scaffolding)', async () => {
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({ text: 'hello world' }),
      NO_CANVAS,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // Fast path: content is the bare string, not an array of parts.
    expect(messages[0].content).toBe('hello world');
  });

  it('returns no messages for an entirely empty turn', async () => {
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({ text: '   ' }),
      NO_CANVAS,
    );
    expect(messages).toEqual([]);
  });

  it('orders skills, selection, and neighbourhood sections with user text last', async () => {
    const refs: AgentNodeRef[] = [
      { id: 'n1', type: 'note', label: 'First', filename: 'nodes/first.md' },
    ];
    const skills: ResolvedSkill[] = [
      { id: 'brainstorm', name: 'Brainstorm', body: 'Diverge then converge.' },
    ];
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({
        text: 'summarize these',
        refs,
        neighbourhood: {
          layers: [
            {
              groups: [
                {
                  dx: 0,
                  dy: -100,
                  arrangement: 'single node',
                  _minEdgeDist: 10,
                  nodes: [
                    buildAgentNodePreview({
                      id: 'near-1',
                      type: 'note',
                      label: 'Above',
                    }),
                  ],
                },
              ],
            },
          ],
          relevantEdges: [],
        },
        resolvedSkills: skills,
      }),
      NO_CANVAS,
    );

    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const flat = textOf(content);

    // All three sections are present and XML-tagged.
    expect(flat).toContain('<selected_nodes>');
    expect(flat).toContain(
      '<node id="n1" type="note" label="First" file="nodes/first.md" />',
    );
    expect(flat).toContain('<canvas_neighbourhood>');
    expect(flat).toContain(
      '<group direction="above" arrangement="single node">',
    );
    expect(flat).toContain('<node id="near-1" type="note" label="Above"');
    expect(flat).toContain('<invoked_skills>');
    expect(flat).toContain('<skill id="brainstorm" name="Brainstorm">');

    // Order: invoked_skills → selected_nodes → canvas_neighbourhood.
    expect(flat.indexOf('<invoked_skills>')).toBeLessThan(
      flat.indexOf('<selected_nodes>'),
    );
    expect(flat.indexOf('<selected_nodes>')).toBeLessThan(
      flat.indexOf('<canvas_neighbourhood>'),
    );

    // The user's own words come LAST, wrapped in <user_request>.
    expect(flat).toContain('<user_request>\nsummarize these\n</user_request>');
    expect(flat.indexOf('<canvas_neighbourhood>')).toBeLessThan(
      flat.indexOf('<user_request>'),
    );
  });

  it('places attachment parts before the user request and keeps user text last', async () => {
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({
        text: 'what does this say?',
        attachments: [
          {
            type: 'text',
            source: 'upload',
            label: 'excerpt',
            content: 'the quick brown fox',
            originNodeId: 'src1',
          },
        ],
      }),
      NO_CANVAS,
    );

    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const flat = textOf(content);

    // No selection/neighbourhood/skills → no context block.
    expect(flat).not.toContain('<selected_nodes>');
    // Attachment excerpt is wrapped in <attachments>/<attachment> and
    // ordered before the user request.
    expect(flat).toContain('<attachments>');
    expect(flat).toContain('<attachment type="text"');
    expect(flat).toContain('the quick brown fox');
    expect(flat).toContain(
      '<user_request>\nwhat does this say?\n</user_request>',
    );
    expect(flat.indexOf('the quick brown fox')).toBeLessThan(
      flat.indexOf('<user_request>'),
    );
  });

  it('renders a source-only attachment as a node reference', async () => {
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({
        text: 'use this source',
        attachments: [
          {
            type: 'text',
            source: 'selection',
            label: 'Adjacent note',
            originNodeId: 'node-adjacent',
          },
        ],
      }),
      NO_CANVAS,
    );

    const flat = textOf(messages[0].content);
    expect(flat).toContain(
      '<attachment type="node" name="Adjacent note" origin="node-adjacent" />',
    );
    expect(flat.indexOf('origin="node-adjacent"')).toBeLessThan(
      flat.indexOf('<user_request>'),
    );
  });

  it('places the sketch-raster hint with the selection visuals', async () => {
    const { messages } = await renderEnvelopeMessages(
      makeEnvelope({
        text: 'enhance this sketch',
        snapshotAttachments: [
          {
            type: 'image',
            source: 'selection',
            label: 'sketch',
            url: 'sketch-raster-abc.png',
            originNodeIds: ['stroke-node-0001', 'stroke-node-0002'],
          },
        ],
      }),
      NO_CANVAS,
    );

    expect(messages).toHaveLength(1);
    const flat = textOf(messages[0].content);
    // The LLM-only hint rides inside the selection-visuals block, not uploads.
    expect(flat).toContain('<selected_nodes_visuals>');
    expect(flat).toContain('referenceArtifactSrcs');
    expect(flat).toContain('sketch-raster-abc.png');
    expect(flat).not.toContain('[SYSTEM hint:');
  });
});

describe('rebuildContextMessages', () => {
  it('re-derives the user message from each stored envelope without duplicating it', async () => {
    const turns: AgentTurn[] = [
      makeTurn(makeEnvelope({ text: 'hi' }), [
        { type: 'text', data: { content: 'sure' } },
      ]),
    ];

    const out = await rebuildContextMessages(turns, NO_CANVAS);

    // Exactly one rendered user message + one projected assistant row —
    // the user message is NOT also present in the transcript.
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('hi');
    expect(out[1].role).toBe('assistant');
  });

  it('omits the neighbourhood when replaying a record written before `rendered`', async () => {
    const neighbourhood: NodeNeighbourhoodContext = {
      layers: [
        {
          groups: [
            {
              dx: 0,
              dy: -100,
              arrangement: 'single node',
              _minEdgeDist: 10,
              nodes: [
                buildAgentNodePreview({
                  id: 'near-1',
                  type: 'note',
                  label: 'Above',
                }),
              ],
            },
          ],
        },
      ],
      relevantEdges: [],
    };
    const envelope = makeEnvelope({ text: 'summarize', neighbourhood });

    // The live turn (built-in dispatch) keeps a fresh neighbourhood…
    const live = await renderEnvelopeMessages(envelope, NO_CANVAS);
    expect(textOf(live.messages[0].content)).toContain(
      '<canvas_neighbourhood>',
    );

    // …but a legacy turn with no `rendered` has to be re-rendered against
    // today's canvas, so its point-in-time neighbourhood is dropped rather
    // than silently replaced with a newer one.
    const out = await rebuildContextMessages(
      [makeTurn(envelope, [])],
      NO_CANVAS,
    );
    expect(textOf(out[0].content)).not.toContain('<canvas_neighbourhood>');
    // The user's own words survive the rebuild.
    expect(textOf(out[0].content)).toContain('summarize');
  });

  it('replays the canonical rendered inputs verbatim, images included', async () => {
    const parts: AgentInputPart[] = [
      {
        type: 'text',
        text: '<canvas_neighbourhood>\nstale\n</canvas_neighbourhood>',
      },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '<user_request>\nlook\n</user_request>' },
    ];
    const turn: AgentTurn = {
      request: createChatSubmission(makeEnvelope({ text: 'look' }), [
        { type: 'parts', parts },
      ]),
      transcript: [],
    };

    const out = await rebuildContextMessages([turn], NO_CANVAS);

    // Byte-identical to what the model saw: the image stays a native image
    // part, and nothing is re-rendered against the current canvas.
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual(parts);
  });

  it('replays a multi-round turn as assistant → toolResult → assistant', async () => {
    const out = await rebuildContextMessages(
      [
        makeTurn(makeEnvelope({ text: 'go' }), [
          {
            type: 'tool_call',
            data: { toolCallId: 't1', title: 'read', rawOutput: 'contents' },
          },
          { type: 'text', data: { content: 'here is the answer' } },
        ]),
      ],
      NO_CANVAS,
    );

    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    // The final prose must not be folded back into the round that called
    // the tool, or the model reads the answer as preceding its own result.
    expect(textOf(out[3].content)).toContain('here is the answer');
  });

  it('replays a failed tool call as an error result', async () => {
    const out = await rebuildContextMessages(
      [
        makeTurn(makeEnvelope({ text: 'go' }), [
          {
            type: 'tool_call',
            data: {
              toolCallId: 't1',
              title: 'write',
              status: 'failed',
              rawOutput: 'permission denied',
            },
          },
        ]),
      ],
      NO_CANVAS,
    );

    const result = out.find((m) => m.role === 'toolResult');
    expect((result as unknown as { isError: boolean }).isError).toBe(true);
  });

  it('produces assistant messages that token estimation can inspect', async () => {
    const out = await rebuildContextMessages(
      [
        makeTurn(makeEnvelope({ text: 'hello' }), [
          { type: 'text', data: { content: 'hi' } },
        ]),
      ],
      NO_CANVAS,
    );

    const model = { contextWindow: 128_000 } as Model<Api>;
    const context = { messages: out } as Context;
    expect(() => clampMaxTokensToContext(model, context, 4_096)).not.toThrow();
  });

  it('skips empty turns but still appends their transcript', async () => {
    const out = await rebuildContextMessages(
      [
        makeTurn(makeEnvelope({ text: '' }), [
          { type: 'text', data: { content: 'auto' } },
        ]),
      ],
      NO_CANVAS,
    );

    // No user message rendered (empty turn), transcript still flows through.
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
  });
});
