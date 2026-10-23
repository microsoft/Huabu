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
  it.each(['white', '#fff', '#ffffff'])(
    'keeps a visible neutral boundary for white accent %s',
    (accent) => {
      expect(nodeBoundaryForAccent(accent).borderColor).toBe(
        'color-mix(in srgb, var(--edge-default) 75%, transparent)',
      );
    },
  );
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
  ])('uses the shared 2px layout border for %s', (type) => {
    expect(nodeLayoutBorderInset(type)).toBe(2);
  });

  it('shares boundaries and retains Note document padding', () => {
    expect(NODE_BORDER_WIDTH).toBe(2);
    expect(nodeBoundaryForAccent(null)).toEqual({
      borderColor: 'color-mix(in srgb, var(--edge-default) 75%, transparent)',
      borderWidth: 2,
    });
    expect(nodeBoundaryForAccent('#008080')).toEqual({
      borderColor: `color-mix(in srgb, ${getAccentTokens('#008080').divider} 75%, transparent)`,
      borderWidth: 2,
    });
    expect(NOTE_SURFACE_DESIGN_CONFIG).toMatchObject({
      borderWidth: 2,
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
