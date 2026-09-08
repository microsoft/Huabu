// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  classifySpaceInstructionFrame,
  classifySpaceInstructionFrameLabel,
  directAgentNodeIdsForFrame,
  isAgentNode,
} from './node.js';

describe('Space instruction Frame labels', () => {
  it.each([
    ['prompt', 'prompt'],
    [' Prompt: Review ', 'prompt'],
    ['SKILL', 'skill'],
    ['skill: Research', 'skill'],
  ] as const)('classifies %s as %s', (label, expected) => {
    expect(classifySpaceInstructionFrameLabel(label)).toBe(expected);
  });

  it.each(['prompt:', 'skill:   ', 'prompt module', '', null])(
    'rejects invalid label %s',
    (label) => {
      expect(classifySpaceInstructionFrameLabel(label)).toBeNull();
    },
  );

  it('requires explicit user or agent label provenance', () => {
    expect(classifySpaceInstructionFrame('skill', 'user')).toBe('skill');
    expect(classifySpaceInstructionFrame('prompt: Task', 'agent')).toBe(
      'prompt',
    );
    expect(classifySpaceInstructionFrame('skill', 'auto')).toBeNull();
    expect(classifySpaceInstructionFrame('prompt', undefined)).toBeNull();
  });
});

describe('Prompt Frame Agent connections', () => {
  const nodes = [
    { id: 'frame', type: 'frame', data: {} },
    {
      id: 'agent-a',
      type: 'question',
      data: { threadId: 'thread-a' },
    },
    {
      id: 'agent-b',
      type: 'question',
      data: { threadId: 'thread-b' },
    },
    { id: 'question-draft', type: 'question', data: {} },
    { id: 'note', type: 'note', data: {} },
  ];

  it('recognises only Question Nodes with a non-empty thread identity', () => {
    expect(isAgentNode(nodes[1])).toBe(true);
    expect(isAgentNode(nodes[3])).toBe(false);
    expect(isAgentNode(nodes[4])).toBe(false);
  });

  it('collects unique direct Agent neighbours in either endpoint order', () => {
    expect(
      directAgentNodeIdsForFrame(
        nodes,
        [
          { source: 'frame', target: 'agent-a' },
          { source: 'agent-b', target: 'frame' },
          { source: 'frame', target: 'agent-a' },
          { source: 'frame', target: 'question-draft' },
          { source: 'frame', target: 'note' },
          { source: 'agent-a', target: 'agent-b' },
        ],
        'frame',
      ),
    ).toEqual(new Set(['agent-a', 'agent-b']));
  });
});
