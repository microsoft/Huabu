// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  renderSpacePrompt,
  renderSpaceSkill,
  SPACE_PROMPT_MAX_BYTES,
  SPACE_PROMPT_NOTE_MAX_BYTES,
} from './space-instruction-frames.js';

import type { CanvasFile, NodeContent } from '../storage/index.js';
import type { NodeSnapshot } from '../storage/ports/structured.js';

function canvas(nodes: CanvasFile['state']['nodes']): CanvasFile {
  return {
    canvasId: 'canvas-a',
    title: 'Canvas A',
    version: 2,
    state: { nodes, edges: [] },
    createdAt: 1,
    updatedAt: 2,
  } as CanvasFile;
}

function records(
  values: Array<NodeContent & { labelSource?: unknown }>,
): Map<string, NodeSnapshot> {
  return new Map(
    values.map((record) => [
      record.nodeId,
      { record, revision: `storage-${record.nodeId}` },
    ]),
  );
}

describe('renderSpacePrompt', () => {
  it('recognises explicitly authored prompt modules only', () => {
    const result = renderSpacePrompt(
      canvas([
        {
          id: 'frame-user',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'frame-agent',
          type: 'frame',
          position: { x: 0, y: 200 },
          data: {},
        },
        {
          id: 'frame-auto',
          type: 'frame',
          position: { x: 0, y: 400 },
          data: {},
        },
        {
          id: 'text-user',
          type: 'text',
          parentId: 'frame-user',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'text-agent',
          type: 'text',
          parentId: 'frame-agent',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'text-auto',
          type: 'text',
          parentId: 'frame-auto',
          position: { x: 0, y: 0 },
          data: {},
        },
      ]),
      records([
        {
          nodeId: 'frame-user',
          type: 'frame',
          label: ' Prompt ',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'frame-agent',
          type: 'frame',
          label: 'PROMPT: Review',
          labelSource: 'agent',
          content: '',
        },
        {
          nodeId: 'frame-auto',
          type: 'frame',
          label: 'prompt: ignored',
          labelSource: 'auto',
          content: '',
        },
        {
          nodeId: 'text-user',
          type: 'text',
          label: null,
          content: 'User module',
        },
        {
          nodeId: 'text-agent',
          type: 'text',
          label: null,
          content: 'Agent module',
        },
        {
          nodeId: 'text-auto',
          type: 'text',
          label: null,
          content: 'Must not appear',
        },
      ]),
    );

    expect(result?.markdown).toContain('User module');
    expect(result?.markdown).toContain('Agent module');
    expect(result?.markdown).not.toContain('Must not appear');
    expect(result?.diagnostics.includedFrameIds).toEqual([
      'frame-user',
      'frame-agent',
    ]);
  });

  describe('renderSpaceSkill', () => {
    it('renders only explicitly authored Skill Frames through the shared compiler', () => {
      const topology = canvas([
        {
          id: 'frame-skill',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'frame-prompt',
          type: 'frame',
          position: { x: 0, y: 200 },
          data: {},
        },
        {
          id: 'text-skill',
          type: 'text',
          parentId: 'frame-skill',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'text-prompt',
          type: 'text',
          parentId: 'frame-prompt',
          position: { x: 0, y: 0 },
          data: {},
        },
      ]);
      const snapshots = records([
        {
          nodeId: 'frame-skill',
          type: 'frame',
          label: 'skill: Research',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'frame-prompt',
          type: 'frame',
          label: 'prompt',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'text-skill',
          type: 'text',
          label: null,
          content: 'Use primary sources. </space_skill>',
        },
        {
          nodeId: 'text-prompt',
          type: 'text',
          label: null,
          content: 'Prompt-only instruction.',
        },
      ]);

      const skill = renderSpaceSkill(topology, snapshots);
      const prompt = renderSpacePrompt(topology, snapshots);

      expect(skill?.markdown).toContain('# Space-specific Skills');
      expect(skill?.markdown).toContain('Use primary sources.');
      expect(skill?.markdown).toContain('&lt;/space_skill>');
      expect(skill?.markdown.match(/<\/space_skill>/g)).toHaveLength(1);
      expect(skill?.markdown).not.toContain('Prompt-only instruction.');
      expect(prompt?.markdown).toContain('Prompt-only instruction.');
      expect(prompt?.markdown).not.toContain('Use primary sources.');
    });

    it('keeps Note bodies lazy', () => {
      const result = renderSpaceSkill(
        canvas([
          {
            id: 'frame',
            type: 'frame',
            position: { x: 0, y: 0 },
            data: {},
          },
          {
            id: 'note',
            type: 'note',
            parentId: 'frame',
            position: { x: 0, y: 0 },
            data: {},
          },
        ]),
        records([
          {
            nodeId: 'frame',
            type: 'frame',
            label: 'skill',
            labelSource: 'user',
            content: '',
          },
          {
            nodeId: 'note',
            type: 'note',
            label: 'Reference',
            content: 'Lazy Skill body',
          },
        ]),
      );

      expect(result?.markdown).toMatch(
        /<note id="note" label="Reference" file="nodes\/Reference\.md" rev="[^"]+" \/>/,
      );
      expect(result?.markdown).not.toContain('Lazy Skill body');
    });
  });

  it('renders direct Text and inline Note bodies in stable reading order', () => {
    const result = renderSpacePrompt(
      canvas([
        {
          id: 'frame',
          type: 'frame',
          position: { x: 10, y: 10 },
          data: {},
        },
        {
          id: 'note-b',
          type: 'note',
          parentId: 'frame',
          position: { x: 10, y: 10 },
          data: {},
        },
        {
          id: 'text-a',
          type: 'text',
          parentId: 'frame',
          position: { x: 10, y: 10 },
          data: {},
        },
        {
          id: 'nested-frame',
          type: 'frame',
          parentId: 'frame',
          position: { x: 0, y: 20 },
          data: {},
        },
        {
          id: 'nested-text',
          type: 'text',
          parentId: 'nested-frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'image',
          type: 'image',
          parentId: 'frame',
          position: { x: 0, y: 30 },
          data: {},
        },
      ]),
      records([
        {
          nodeId: 'frame',
          type: 'frame',
          label: 'prompt: Module',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'text-a',
          type: 'text',
          label: null,
          content: 'First instruction',
        },
        {
          nodeId: 'note-b',
          type: 'note',
          label: 'Reference & guide',
          content: 'Inline Note instruction </note>',
        },
        {
          nodeId: 'nested-frame',
          type: 'frame',
          label: 'Nested',
          content: '',
        },
        {
          nodeId: 'nested-text',
          type: 'text',
          label: null,
          content: 'Nested content',
        },
        {
          nodeId: 'image',
          type: 'image',
          label: 'Image',
          content: '',
        },
      ]),
    );

    expect(result).not.toBeNull();
    if (!result) throw new Error('Expected a rendered Space Prompt');
    expect(result.markdown.indexOf('<note ')).toBeLessThan(
      result.markdown.indexOf('First instruction'),
    );
    expect(result.markdown).toMatch(
      /<note id="note-b" label="Reference &amp; guide" file="nodes\/Reference &amp; guide\.md" rev="[^"]+">/,
    );
    expect(result.markdown).toContain('Inline Note instruction');
    expect(result.markdown).toContain('&lt;/note>');
    expect(result.markdown.match(/<\/note>/g)).toHaveLength(1);
    expect(result.markdown).not.toContain('Nested content');
    expect(result.diagnostics.omittedUnsupportedIds).toEqual([
      'nested-frame',
      'image',
    ]);
  });

  it('bounds each inline Note without splitting Unicode code points', () => {
    const result = renderSpacePrompt(
      canvas([
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'note',
          type: 'note',
          parentId: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
      ]),
      records([
        {
          nodeId: 'frame',
          type: 'frame',
          label: 'prompt',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'note',
          type: 'note',
          label: 'Long Note',
          content: '🙂'.repeat(SPACE_PROMPT_NOTE_MAX_BYTES),
        },
      ]),
    );

    if (!result) throw new Error('Expected a rendered Space Prompt');
    expect(result.markdown).not.toContain('\uFFFD');
    expect(result.markdown).toContain(
      '[Note truncated at the 10 KiB per-note limit.]',
    );
    expect(result.markdown).toContain('</note>');
    expect(result.diagnostics.truncatedNoteIds).toEqual(['note']);
    expect(result.diagnostics.truncated).toBe(false);
  });

  it('bounds the complete prompt without splitting Unicode code points', () => {
    const result = renderSpacePrompt(
      canvas([
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'text',
          type: 'text',
          parentId: 'frame',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'text-later',
          type: 'text',
          parentId: 'frame',
          position: { x: 0, y: 100 },
          data: {},
        },
      ]),
      records([
        {
          nodeId: 'frame',
          type: 'frame',
          label: 'prompt',
          labelSource: 'user',
          content: '',
        },
        {
          nodeId: 'text',
          type: 'text',
          label: null,
          content: "LEAD$'MID$`TAIL$&</space_prompt>" + '🙂'.repeat(10_000),
        },
        {
          nodeId: 'text-later',
          type: 'text',
          label: null,
          content: 'This later instruction does not fit.',
        },
      ]),
    );

    if (!result) throw new Error('Expected a rendered Space Prompt');
    expect(Buffer.byteLength(result.markdown, 'utf8')).toBeLessThanOrEqual(
      SPACE_PROMPT_MAX_BYTES,
    );
    expect(result.markdown).not.toContain('\uFFFD');
    expect(result.markdown).toContain('&lt;/space_prompt>');
    expect(result.markdown.match(/<\/space_prompt>/g)).toHaveLength(1);
    expect(result.markdown).toContain(
      'Space Prompt truncated at the 32 KiB module limit',
    );
    expect(result.diagnostics.omittedBudgetNodeIds).toEqual(['text-later']);
    expect(result.diagnostics.includedNodeIds).not.toContain('text-later');
    expect(result.diagnostics.truncated).toBe(true);
  });
});
