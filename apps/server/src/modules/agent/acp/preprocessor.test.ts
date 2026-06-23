/**
 * Tests for the deterministic preprocessor.
 *
 * Lock the on-the-wire shape of `serializePrompt` (rendered from
 * `prompt/external-agent/prompt.md`) and the slash-command
 * short-circuit / node-flattening behaviour of
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
  it('emits task-only output when there are no selected nodes', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Explain the difference between async iterators and generators.',
      selectedNodes: [],
    };

    const out = serializePrompt(prompt);

    expect(out).toBe(
      'Explain the difference between async iterators and generators.',
    );
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

  it('omits the sideband section unless sidebandEnabled is set', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      selectedNodes: [{ nodeId: 'n1', type: 'note' }],
    };

    expect(serializePrompt(prompt)).not.toContain('## Canvas Tools (Sideband)');
    expect(serializePrompt(prompt, { sidebandEnabled: true })).toContain(
      '## Canvas Tools (Sideband)',
    );
  });

  it('mentions read-node in the intro only when sideband is enabled', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      selectedNodes: [{ nodeId: 'n1', type: 'note' }],
    };

    expect(serializePrompt(prompt, { sidebandEnabled: true })).toContain(
      'read-node <node-id>',
    );
    expect(serializePrompt(prompt)).not.toContain('read-node <node-id>');
  });

  it('escapes pipe characters in labels so the table cannot break', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      selectedNodes: [{ nodeId: 'n1', type: 'note', label: 'a | b' }],
    };

    expect(serializePrompt(prompt)).toContain('| `n1` | note | a \\| b |');
  });
});

describe('prepareExternalAgentPrompt', () => {
  it('forwards slash commands verbatim without extra sections', () => {
    const result = prepareExternalAgentPrompt({
      rawText: '/compact please',
      agentAlias: 'claude',
      canvasId: 'canvas-1',
      logger,
    });

    expect(result.prompt).toEqual({
      task: '/compact please',
      selectedNodes: [],
    });
    expect(result.serialized).toBe('/compact please');
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
      canvasId: 'canvas-1',
      logger,
    });

    expect(result.prompt.task).toBe('do something');
    expect(result.prompt.selectedNodes).toEqual([
      { nodeId: 'frame-1', type: 'frame', label: 'Group' },
      { nodeId: 'child-1', type: 'note', label: 'Child' },
    ]);
    expect(result.serialized).toContain('| `child-1` | note | Child |');
    // canvasId present → sideband section rendered.
    expect(result.serialized).toContain('## Canvas Tools (Sideband)');
  });

  it('omits the sideband section when no canvasId is bound', () => {
    const result = prepareExternalAgentPrompt({
      rawText: 'no canvas here',
      agentAlias: 'claude',
      canvasContext: {
        selectedNodes: [{ id: 'n1', type: 'note', label: 'L' }],
      },
      logger,
    });

    expect(result.serialized).not.toContain('## Canvas Tools (Sideband)');
    expect(result.serialized).toContain('## Selected Nodes');
  });
});
