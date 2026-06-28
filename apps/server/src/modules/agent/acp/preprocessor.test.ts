/**
 * Tests for the deterministic preprocessor.
 *
 * Lock the on-the-wire shape of `serializePrompt` (rendered from
 * `prompt/external-agent/user_prompt.md`, with the one-shot
 * `system_prompt.md` preamble prepended on the first turn) and the
 * slash-command short-circuit / node-flattening behaviour of
 * `prepareExternalAgentPrompt`, so the format the external agent sees
 * can't regress silently.
 */

import { describe, expect, it, vi } from 'vitest';

import { prepareExternalAgentPrompt, serializePrompt } from './preprocessor.js';
import { buildAgentNodeRef } from '../node-ref.js';

import type { ChatEnvelope } from '../context/envelope.js';
import type {
  CanvasNodeType,
  ChatAttachment,
  ExternalAgentPrompt,
} from '@sediment/shared';
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
 * `preamble.nodeNeighbourhood`) carry meaningful values; the rest are
 * inert defaults so the envelope type-checks.
 */
function makeEnvelope(opts: {
  text: string;
  selection?: { id: string; type: CanvasNodeType; label?: string }[];
  neighbourhood?: string;
  attachments?: ChatAttachment[];
}): ChatEnvelope {
  return {
    preamble: opts.neighbourhood
      ? { nodeNeighbourhood: opts.neighbourhood }
      : {},
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
    },
  };
}

describe('serializePrompt', () => {
  it('emits the verbatim task and no selected-nodes section when nothing is selected', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Explain the difference between async iterators and generators.',
      selectedNodes: [],
    };

    const out = serializePrompt(prompt);

    // No context sections → bare task, no XML scaffolding (mirrors the
    // built-in plain-text fast path).
    expect(out).toBe(
      'Explain the difference between async iterators and generators.',
    );
    expect(out).not.toContain('<selected_nodes>');
  });

  it('wraps a selected-nodes table in <selected_nodes> when nodes are present', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Compare these notes.',
      selectedNodes: [
        { nodeId: 'node-a', type: 'note', label: 'Intro' },
        { nodeId: 'node-b', type: 'image' },
      ],
    };

    const out = serializePrompt(prompt);

    expect(out).toContain('<selected_nodes>');
    expect(out).toContain('</selected_nodes>');
    expect(out).toContain('| Node ID | Type | Label |');
    expect(out).toContain('| `node-a` | note | Intro |');
    // Label-less node renders an em-dash placeholder.
    expect(out).toContain('| `node-b` | image | — |');
    // The user's words come last, wrapped in <user_request>.
    expect(out).toContain(
      '<user_request>\nCompare these notes.\n</user_request>',
    );
    expect(out.indexOf('<selected_nodes>')).toBeLessThan(
      out.indexOf('<user_request>'),
    );
  });

  it('mentions read-node in the selected-nodes intro', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      selectedNodes: [{ nodeId: 'n1', type: 'note' }],
    };

    expect(serializePrompt(prompt)).toContain('read-node <node-id>');
  });

  it('escapes pipe characters in labels so the table cannot break', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      selectedNodes: [{ nodeId: 'n1', type: 'note', label: 'a | b' }],
    };

    expect(serializePrompt(prompt)).toContain('| `n1` | note | a \\| b |');
  });
  it('wraps off-canvas attachments in <attachments> before the user request', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'summarize the attached note',
      selectedNodes: [],
      attachments: [
        { type: 'text', label: 'excerpt', content: 'the quick brown fox' },
        {
          type: 'web',
          label: 'FX outlook',
          url: 'https://example.com/fx',
          content: 'continued volatility into Q4',
        },
      ],
    };

    const out = serializePrompt(prompt);

    expect(out).toContain('<attachments>');
    expect(out).toContain('</attachments>');
    expect(out).toContain('<attachment type="text" name="excerpt">');
    expect(out).toContain('the quick brown fox');
    expect(out).toContain(
      '<attachment type="web" name="FX outlook" url="https://example.com/fx">',
    );
    // The user's words still come last.
    expect(out.indexOf('<attachments>')).toBeLessThan(
      out.indexOf('<user_request>'),
    );
  });
  it('omits the system preamble by default and prepends it when includeSystem is set', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'ZZ_UNIQUE_TASK_BODY',
      selectedNodes: [],
    };

    const withoutSystem = serializePrompt(prompt);
    expect(withoutSystem).not.toContain('## Canvas Tools (Reachback)');
    expect(withoutSystem).not.toContain('Huabu');

    const withSystem = serializePrompt(prompt, { includeSystem: true });
    expect(withSystem).toContain('## Canvas Tools (Reachback)');
    expect(withSystem).toContain('Huabu');
    // The preamble precedes the per-turn request body.
    expect(withSystem.indexOf('## Canvas Tools (Reachback)')).toBeLessThan(
      withSystem.indexOf('ZZ_UNIQUE_TASK_BODY'),
    );
  });
});

describe('prepareExternalAgentPrompt', () => {
  it('forwards slash commands verbatim and never includes the system preamble', () => {
    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({ text: '/compact please' }),
      agentAlias: 'claude',
      includeSystem: true,
      logger,
    });

    expect(result.prompt).toEqual({
      task: '/compact please',
      selectedNodes: [],
    });
    expect(result.serialized).toBe('/compact please');
    // Even when asked to include it, a slash short-circuit must not —
    // so the flag stays unsent for the next real turn.
    expect(result.includedSystem).toBe(false);
  });

  it('builds selectedNodes from the envelope selection refs', () => {
    const result = prepareExternalAgentPrompt({
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

    expect(result.prompt.task).toBe('do something');
    expect(result.prompt.selectedNodes).toEqual([
      { nodeId: 'frame-1', type: 'frame', label: 'Group' },
      { nodeId: 'child-1', type: 'note', label: 'Child' },
    ]);
    expect(result.serialized).toContain('| `child-1` | note | Child |');
    expect(result.includedSystem).toBe(false);
  });

  it('includes the system preamble on the first turn when includeSystem is set', () => {
    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({ text: 'first message' }),
      agentAlias: 'claude',
      includeSystem: true,
      logger,
    });

    expect(result.includedSystem).toBe(true);
    expect(result.serialized).toContain('## Canvas Tools (Reachback)');
    expect(result.serialized).toContain('first message');
    // The structured prompt also carries the rendered preamble so the
    // UI can show the complete prompt the agent saw.
    expect(result.prompt.systemPreamble).toContain(
      '## Canvas Tools (Reachback)',
    );
  });

  it('omits systemPreamble from the structured prompt when includeSystem is unset', () => {
    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({ text: 'later message' }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.includedSystem).toBe(false);
    expect(result.prompt.systemPreamble).toBeUndefined();
  });

  it('renders a canvas-neighbourhood section when the envelope carries one', () => {
    const neighbourhood =
      '### Canvas Level\n\n**to the left** (2 nodes):\n- "sketch-a" [sketch]';

    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({ text: 'generate an image', neighbourhood }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.prompt.neighbourhood).toBe(neighbourhood);
    expect(result.serialized).toContain('<canvas_neighbourhood>');
    expect(result.serialized).toContain('**to the left** (2 nodes):');
    // The user's request comes LAST; the neighbourhood precedes it.
    expect(result.serialized.indexOf('<canvas_neighbourhood>')).toBeLessThan(
      result.serialized.indexOf('generate an image'),
    );
  });

  it('omits the canvas-neighbourhood section when the envelope has none', () => {
    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({ text: 'plain request' }),
      agentAlias: 'claude',
      logger,
    });

    expect(result.prompt.neighbourhood).toBeUndefined();
    expect(result.serialized).not.toContain('<canvas_neighbourhood>');
  });

  it('drops the neighbourhood for slash-command short-circuits', () => {
    const result = prepareExternalAgentPrompt({
      envelope: makeEnvelope({
        text: '/compact now',
        neighbourhood: '### Canvas Level\n\n- "x" [note]',
      }),
      agentAlias: 'claude',
      includeSystem: true,
      logger,
    });

    expect(result.prompt).toEqual({ task: '/compact now', selectedNodes: [] });
    expect(result.serialized).toBe('/compact now');
  });

  it('forwards off-canvas text uploads into the prompt attachments', () => {
    const result = prepareExternalAgentPrompt({
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

    expect(result.prompt.attachments).toEqual([
      {
        type: 'text',
        label: 'excerpt',
        content: 'Q3 exposure rose 12% on fx volatility.',
      },
    ]);
    expect(result.serialized).toContain('<attachments>');
    expect(result.serialized).toContain(
      'Q3 exposure rose 12% on fx volatility.',
    );
  });

  it('reduces a content-less image upload to a locator note', () => {
    const result = prepareExternalAgentPrompt({
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

    expect(result.prompt.attachments).toHaveLength(1);
    expect(result.prompt.attachments?.[0].content).toContain(
      'not visible to this agent',
    );
  });
});
