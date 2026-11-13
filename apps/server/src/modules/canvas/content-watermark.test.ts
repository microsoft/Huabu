// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  contentSavedSince,
  contentWatermark,
  recordContentSave,
  resetContentWatermarkForTests,
} from './content-watermark.js';

beforeEach(() => resetContentWatermarkForTests());

describe('content watermark', () => {
  it('names the nodes of a Space saved after a position, each once', () => {
    const start = contentWatermark();
    recordContentSave('space-a', ['n1']);
    const middle = contentWatermark();
    recordContentSave('space-a', ['n2']);
    recordContentSave('space-b', ['other']);
    // Typing saves the same node again and again.
    recordContentSave('space-a', ['n2']);
    recordContentSave('space-a', ['n1']);

    expect(contentSavedSince('space-a', start)?.sort()).toEqual(['n1', 'n2']);
    expect(contentSavedSince('space-a', middle)?.sort()).toEqual(['n1', 'n2']);
    expect(contentSavedSince('space-b', middle)).toEqual(['other']);
    expect(contentSavedSince('space-a', contentWatermark())).toEqual([]);
    // A Space nothing was saved in has nothing to name.
    expect(contentSavedSince('space-c', start)).toEqual([]);
  });

  it('gives every save the next sequence', () => {
    const first = recordContentSave('space-a', ['n1']);
    expect(recordContentSave('space-b', ['n1'])).toBe(first + 1);
    expect(contentWatermark().seq).toBe(first + 1);
  });

  it('cannot tell for a position of another server process or a later one', () => {
    recordContentSave('space-a', ['n1']);
    const now = contentWatermark();
    expect(
      contentSavedSince('space-a', { ...now, epoch: 'before-restart' }),
    ).toBe(null);
    expect(contentSavedSince('space-a', { ...now, seq: now.seq + 5 })).toBe(
      null,
    );
  });

  it('cannot tell once more distinct nodes were saved than it remembers', () => {
    const start = contentWatermark();
    for (let index = 0; index < 512; index++)
      recordContentSave('space-a', [`n${index}`]);
    const full = contentWatermark();
    expect(contentSavedSince('space-a', start)).toHaveLength(512);

    recordContentSave('space-a', ['one-more']);
    // The oldest save was forgotten: a page that old must check everything.
    expect(contentSavedSince('space-a', start)).toBe(null);
    // A page that had seen everything up to `full` is still answered.
    expect(contentSavedSince('space-a', full)).toEqual(['one-more']);
  });

  it('cannot tell for a Space whose record was dropped to make room', () => {
    const start = contentWatermark();
    recordContentSave('space-old', ['n1']);
    const seenOld = contentWatermark();
    for (let index = 0; index < 256; index++)
      recordContentSave(`space-${index}`, ['n']);

    expect(contentSavedSince('space-old', start)).toBe(null);
    expect(contentSavedSince('space-old', seenOld)).toBe(null);
    // Positions taken after the drop are answered again.
    const later = contentWatermark();
    recordContentSave('space-old', ['n2']);
    expect(contentSavedSince('space-old', later)).toEqual(['n2']);
    // A Space never saved in is unknown before the drop too.
    expect(contentSavedSince('space-new', start)).toBe(null);
    expect(contentSavedSince('space-new', later)).toEqual([]);
  });
});
