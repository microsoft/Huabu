// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  NOTE_CONTENT_HOST_CLASS,
  NOTE_CONTENT_HOST_SCOPE_CLASS,
  NOTE_CONTENT_HOST_STYLE,
  NOTE_FIRST_BLOCK_CLASS,
} from './noteContentHost';
import { NODE_TYPOGRAPHY_STYLE } from '../design/nodeTypography';

describe('Note content host', () => {
  it('scopes the first top-level block margin reset to mounted and measured Notes', () => {
    expect(NOTE_CONTENT_HOST_CLASS.split(' ')).toContain(
      NOTE_CONTENT_HOST_SCOPE_CLASS,
    );
    expect(NOTE_CONTENT_HOST_STYLE).toEqual({
      ...NODE_TYPOGRAPHY_STYLE,
      boxSizing: 'border-box',
      paddingBlock: '16px',
      paddingInline: '16px',
    });

    const noteNode = readFileSync(
      'src/components/Nodes/note/NoteContentViewport.tsx',
      'utf8',
    );
    expect(noteNode).toContain('style={NOTE_CONTENT_HOST_STYLE}');

    const offscreenMeasurer = readFileSync(
      'src/components/Nodes/shared/height/measure/offscreenMeasurer.ts',
      'utf8',
    );
    expect(offscreenMeasurer).toContain(
      'Object.assign(content.style, NOTE_CONTENT_HOST_STYLE)',
    );

    const overrides = readFileSync(
      'src/components/Milkdown/milkdown-overrides.css',
      'utf8',
    );
    expect(overrides).toMatch(
      new RegExp(
        `\\.${NOTE_CONTENT_HOST_SCOPE_CLASS} \\.ProseMirror > \\.${NOTE_FIRST_BLOCK_CLASS}\\s*\\{[^}]*margin-top:\\s*0;`,
      ),
    );
  });
});
