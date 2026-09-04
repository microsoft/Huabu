// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  classifySpaceInstructionFrame,
  classifySpaceInstructionFrameLabel,
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
