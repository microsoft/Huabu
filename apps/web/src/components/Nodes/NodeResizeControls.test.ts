// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodeResizePolicy } from './NodeResizeControls';

describe('nodeResizePolicy', () => {
  it('only exposes horizontal reflow edges for Space Shortcuts', () => {
    expect(nodeResizePolicy('spacePreview')).toEqual(
      ['left', 'right'].map((position) => ({
        position,
        edge: true,
        mode: 'width',
        lockAspect: false,
        cursor: 'ew-resize',
      })),
    );
  });
  it.each(['text', 'question'])(
    '%s exposes width reflow edges and proportional corners',
    (type) => {
      const policy = nodeResizePolicy(type, true);
      expect(policy.filter((control) => control.edge)).toEqual(
        ['left', 'right'].map((position) => ({
          position,
          edge: true,
          mode: 'width',
          lockAspect: false,
          cursor: 'ew-resize',
        })),
      );
      expect(policy.filter((control) => !control.edge)).toHaveLength(4);
      expect(
        policy
          .filter((control) => !control.edge)
          .every((control) => control.mode === 'scale' && control.lockAspect),
      ).toBe(true);
    },
  );

  it.each(['note', 'pdf', 'web'])('%s keeps ordinary box controls', (type) => {
    const policy = nodeResizePolicy(type);
    expect(policy).toHaveLength(8);
    expect(policy.every((control) => control.mode === 'fit')).toBe(true);
  });

  it.each(['image', 'video'])(
    '%s keeps aspect-locked corner controls',
    (type) => {
      const policy = nodeResizePolicy(type);
      expect(policy).toHaveLength(4);
      expect(
        policy.every((control) => !control.edge && control.lockAspect),
      ).toBe(true);
    },
  );
});
