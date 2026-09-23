// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getAccentTokens } from './accentTokens';
import {
  NODE_BORDER_WIDTH,
  nodeBoundaryForAccent,
  nodeLayoutBorderInset,
} from './nodeBoundary';
import {
  NOTE_SURFACE_DESIGN_CONFIG,
  noteBoundaryForAccent,
} from '../note/noteDesign';

describe('shared node boundary', () => {
  it.each(['image', 'video', 'sketch'])(
    'reserves no layout border for %s',
    (type) => {
      expect(nodeLayoutBorderInset(type)).toBe(0);
    },
  );

  it.each([
    'note',
    'pdf',
    'web',
    'text',
    'question',
    'audio',
    'office',
    'spacePreview',
    undefined,
  ])('preserves the ordinary 3px layout border for %s', (type) => {
    expect(nodeLayoutBorderInset(type)).toBe(3);
  });

  it('shares boundaries without changing Note document geometry', () => {
    expect(NODE_BORDER_WIDTH).toBe(3);
    expect(nodeBoundaryForAccent(null)).toEqual({
      borderColor: 'var(--edge-default)',
      borderWidth: 3,
    });
    expect(nodeBoundaryForAccent('#008080')).toEqual({
      borderColor: getAccentTokens('#008080').divider,
      borderWidth: 3,
    });
    expect(NOTE_SURFACE_DESIGN_CONFIG).toMatchObject({
      borderWidth: 3,
      contentPaddingBlock: 16,
      contentPaddingInline: 16,
    });
  });

  it.each([null, '#008080'])(
    'keeps Note boundaries consistent for %s',
    (accent) => {
      expect(noteBoundaryForAccent(accent)).toEqual(
        nodeBoundaryForAccent(accent),
      );
    },
  );
});
