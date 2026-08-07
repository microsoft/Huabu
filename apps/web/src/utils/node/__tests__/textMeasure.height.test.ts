// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Height contract of the text measurement used by TextNode / QuestionNode.
 *
 * The trailing-newline reservation is deliberate and must stay: pretext
 * drops a trailing empty line the way CSS does, but the user pressed
 * Enter, the caret sits on that line, and the node has to leave room for
 * it. Removing it would make the box jump under the caret while typing.
 */

import { describe, expect, it } from 'vitest';

import { measureTextHeight, type FontOpts } from '../textMeasure';

const opts: FontOpts = {
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  lineHeight: 1.5,
};

const FONT_SIZE = 16;
const LINE = Math.ceil(FONT_SIZE * opts.lineHeight);
const WIDTH = 400;

const measure = (text: string) =>
  measureTextHeight(text, WIDTH, FONT_SIZE, opts);

describe('measureTextHeight', () => {
  it('counts one line per rendered line', () => {
    expect(measure('one')).toBe(LINE);
    expect(measure('one\ntwo')).toBe(LINE * 2);
  });

  it('reserves the caret line the user opened with Enter', () => {
    expect(measure('one\n')).toBe(LINE * 2);
    expect(measure('one\ntwo\n')).toBe(LINE * 3);
  });

  it('reserves only one line however many blank lines trail', () => {
    // pretext lays out the interior blank lines itself; only the final
    // one it drops needs adding back.
    expect(measure('one\n\n')).toBe(LINE * 3);
  });
});
