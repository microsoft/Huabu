// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  collectMarkdownArtifactRefs,
  markdownArtifactFields,
  parseArtifactRef,
  rewriteMarkdownArtifactRefs,
} from '../artifact-url.js';

describe('markdownArtifactFields', () => {
  it('walks a note body', () => {
    expect(markdownArtifactFields({ type: 'note', content: 'x' })).toEqual([
      'content',
    ]);
  });

  it('leaves prose-bearing node types alone', () => {
    expect(markdownArtifactFields({ type: 'text', content: 'x' })).toEqual([]);
    expect(markdownArtifactFields({ type: 'question', content: 'x' })).toEqual(
      [],
    );
    expect(markdownArtifactFields({})).toEqual([]);
  });
});

describe('parseArtifactRef', () => {
  it('treats a bare key as owned by the caller-supplied canvas', () => {
    expect(parseArtifactRef('art_abc.png')).toEqual({
      canvasId: null,
      key: 'art_abc.png',
    });
  });

  it('extracts the owning canvas from a canvas-scoped URL', () => {
    expect(parseArtifactRef('/api/canvas/cv_1/artifact/art_abc.png')).toEqual({
      canvasId: 'cv_1',
      key: 'art_abc.png',
    });
  });

  it('rejects references the server-side clone cannot handle', () => {
    expect(parseArtifactRef('data:image/png;base64,AAA')).toBeNull();
    expect(parseArtifactRef('blob:http://localhost/abc')).toBeNull();
    expect(parseArtifactRef('https://example.com/a.png')).toBeNull();
    expect(parseArtifactRef('./relative/a.png')).toBeNull();
    expect(parseArtifactRef('')).toBeNull();
    expect(parseArtifactRef(undefined)).toBeNull();
  });
});

describe('collectMarkdownArtifactRefs', () => {
  it('collects distinct embedded image references', () => {
    const markdown = [
      '# Title',
      '![one](art_one.png)',
      '![again](art_one.png)',
      '![titled](art_two.png "caption")',
      '![angle](<art_three.png>)',
      '![legacy](/api/canvas/cv_src/artifact/art_four.png)',
      '![external](https://example.com/a.png)',
      '![inline](data:image/png;base64,AAA)',
      '[not an image](art_five.png)',
    ].join('\n\n');

    expect(collectMarkdownArtifactRefs(markdown)).toEqual([
      'art_one.png',
      'art_two.png',
      'art_three.png',
      '/api/canvas/cv_src/artifact/art_four.png',
    ]);
  });

  it('returns nothing for empty or image-free markdown', () => {
    expect(collectMarkdownArtifactRefs('')).toEqual([]);
    expect(collectMarkdownArtifactRefs('plain text')).toEqual([]);
  });
});

describe('rewriteMarkdownArtifactRefs', () => {
  it('rewrites only the destinations the resolver maps', () => {
    const markdown =
      '![one](art_one.png)\n\n![two](<art_two.png>)\n\n![keep](art_keep.png "cap")';
    const map = new Map([
      ['art_one.png', 'art_new_one.png'],
      ['art_two.png', 'art_new_two.png'],
    ]);

    expect(rewriteMarkdownArtifactRefs(markdown, (ref) => map.get(ref))).toBe(
      '![one](art_new_one.png)\n\n![two](art_new_two.png)\n\n![keep](art_keep.png "cap")',
    );
  });

  it('preserves the trailing title and closing paren', () => {
    expect(
      rewriteMarkdownArtifactRefs('![a](old.png "title")', () => 'new.png'),
    ).toBe('![a](new.png "title")');
  });

  it('leaves markdown links untouched', () => {
    expect(rewriteMarkdownArtifactRefs('[a](old.png)', () => 'new.png')).toBe(
      '[a](old.png)',
    );
  });
});
