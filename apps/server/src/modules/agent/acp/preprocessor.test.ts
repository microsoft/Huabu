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

import type { ExternalAgentPrompt, WireSelectionNode } from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

/** Minimal logger stub — only `debug` is exercised. */
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

describe('serializePrompt', () => {
  it('emits the verbatim task and no Selected Nodes section when nothing is selected', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Explain the difference between async iterators and generators.',
      selectedNodes: [],
    };

    const out = serializePrompt(prompt);

    expect(out).toContain(
      'Explain the difference between async iterators and generators.',
    );
    expect(out).not.toContain('## Selected Nodes');
  });

  it('renders a Selected Nodes table when nodes are present', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Compare these notes.',
      selectedNodes: [
        { nodeId: 'node-a', type: 'note', label: 'Intro' },
        { nodeId: 'node-b', type: 'image' },
      ],
    };

    const out = serializePrompt(prompt);

    expect(out).toContain('Compare these notes.');
    expect(out).toContain('## Selected Nodes');
    expect(out).toContain('| Node ID | Type | Label |');
    expect(out).toContain('| `node-a` | note | Intro |');
    // Label-less node renders an em-dash placeholder.
    expect(out).toContain('| `node-b` | image | — |');
  });

  it('mentions read-node in the Selected Nodes intro', () => {
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

  it('omits the system preamble by default and prepends it when includeSystem is set', () => {
    const prompt: ExternalAgentPrompt = { task: 'task', selectedNodes: [] };

    const withoutSystem = serializePrompt(prompt);
    expect(withoutSystem).not.toContain('## Canvas Tools (Reachback)');
    expect(withoutSystem).not.toContain('Huabu');

    const withSystem = serializePrompt(prompt, { includeSystem: true });
    expect(withSystem).toContain('## Canvas Tools (Reachback)');
    expect(withSystem).toContain('Huabu');
    // The preamble precedes the per-turn request body.
    expect(withSystem.indexOf('## Canvas Tools (Reachback)')).toBeLessThan(
      withSystem.indexOf('## Request'),
    );
  });
});

describe('prepareExternalAgentPrompt', () => {
  it('forwards slash commands verbatim and never includes the system preamble', () => {
    const result = prepareExternalAgentPrompt({
      rawText: '/compact please',
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

  it('builds selectedNodes from the (flattened) selection', () => {
    const selectedNodes: WireSelectionNode[] = [
      {
        id: 'frame-1',
        type: 'frame',
        label: 'Group',
        children: [{ id: 'child-1', type: 'note', label: 'Child' }],
      },
    ];

    const result = prepareExternalAgentPrompt({
      rawText: 'do something',
      agentAlias: 'claude',
      canvasContext: { selectedNodes },
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
      rawText: 'first message',
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
      rawText: 'later message',
      agentAlias: 'claude',
      logger,
    });

    expect(result.includedSystem).toBe(false);
    expect(result.prompt.systemPreamble).toBeUndefined();
  });
});
