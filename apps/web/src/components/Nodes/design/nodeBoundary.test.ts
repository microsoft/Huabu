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
        'var(--edge-default)',
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
  ])('uses the shared 1px layout border for %s', (type) => {
    expect(nodeLayoutBorderInset(type)).toBe(1);
  });

  it('shares boundaries and retains Note document padding', () => {
    expect(NODE_BORDER_WIDTH).toBe(1);
    expect(nodeBoundaryForAccent(null)).toEqual({
      borderColor: 'var(--edge-default)',
      borderWidth: 1,
    });
    expect(nodeBoundaryForAccent('#008080')).toEqual({
      borderColor: getAccentTokens('#008080').border,
      borderWidth: 1,
    });
    expect(NOTE_SURFACE_DESIGN_CONFIG).toMatchObject({
      borderWidth: 1,
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
