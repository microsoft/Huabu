// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { memo } from 'react';

// Classify one Unicode code point at a time; never backtrack over text runs.
const OPENING = /[\p{Ps}\p{Pi}"'“‘《「『]/u;
const WORD_START = /[\p{Script=Latin}\p{N}]/u;
const WORD_CONTINUATION = /[\p{Script=Latin}\p{M}\p{N}'’_-]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
const CLOSING = /[\p{Pe}\p{Pf},.;:!?，。；：！？、…"'”’》」』]/u;
const SEPARATOR = /[-–—:：|/·•]/u;

function codePointAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) ?? 0);
}

function scanRun(text: string, start: number, pattern: RegExp): number {
  let end = start;
  while (end < text.length) {
    const character = codePointAt(text, end);
    if (!pattern.test(character)) break;
    end += character.length;
  }
  return end;
}

function scanSuffix(text: string, start: number): number {
  let end = start;
  while (end < text.length) {
    const character = codePointAt(text, end);
    if (CLOSING.test(character) || SEPARATOR.test(character)) {
      end += character.length;
    } else if (character === ' ' || character === '\t') {
      const spacesStart = end;
      do {
        end += 1;
      } while (text[end] === ' ' || text[end] === '\t');
      // Spaces belong to the suffix only when followed by a separator.
      if (!SEPARATOR.test(codePointAt(text, end))) return spacesStart;
    } else {
      break;
    }
  }
  return end;
}

/** Alternate plain text and Latin-word spans, preserving every source character. */
function splitWords(text: string): string[] {
  const parts: string[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const start = index;
    index = scanRun(text, index, OPENING);
    const character = codePointAt(text, index);
    if (!WORD_START.test(character)) {
      // Skip a failed opening run as a whole, rather than retrying each opener.
      index += character.length;
      continue;
    }
    index = scanRun(text, index + character.length, WORD_CONTINUATION);
    index = scanSuffix(text, index);
    parts.push(text.slice(plainStart, start), text.slice(start, index));
    plainStart = index;
  }
  parts.push(text.slice(plainStart));
  return parts;
}

/** Bind only boundary characters; the word interior remains free to wrap. */
function splitPunctuation(text: string): string[] {
  const parts: string[] = [];
  let plainStart = 0;
  const openingEnd = scanRun(text, 0, OPENING);
  const first = codePointAt(text, openingEnd);
  if (openingEnd > 0 && LETTER_OR_NUMBER.test(first)) {
    plainStart = scanRun(text, openingEnd + first.length, MARK);
    parts.push('', text.slice(0, plainStart));
  }

  // Only the last letter/number can begin a suffix. Earlier candidates cannot
  // reach the end through punctuation, so internal separator runs need no retry.
  let lastBase = -1;
  let baseEnd = plainStart;
  for (let index = plainStart; index < text.length; ) {
    const character = codePointAt(text, index);
    if (LETTER_OR_NUMBER.test(character)) {
      lastBase = index;
      baseEnd = index + character.length;
    }
    index += character.length;
  }
  if (lastBase >= 0) {
    const marksEnd = scanRun(text, baseEnd, MARK);
    if (marksEnd < text.length && scanSuffix(text, marksEnd) === text.length) {
      parts.push(text.slice(plainStart, lastBase), text.slice(lastBase));
      plainStart = text.length;
    }
  }
  parts.push(text.slice(plainStart));
  return parts;
}

/** Keep unchanged text nodes stable while the label's screen bounds change. */
export const FarZoomText = memo(function FarZoomText({
  text,
}: {
  text: string;
}) {
  return splitWords(text).map((part, index) =>
    index % 2 === 1 ? (
      <span
        key={index}
        data-study-word=""
        style={{
          overflowWrap: 'anywhere',
          wordBreak: 'normal',
          whiteSpace: 'normal',
          hyphens: 'none',
        }}
      >
        {splitPunctuation(part).map((piece, boundary) =>
          boundary % 2 === 1 ? (
            <span
              key={boundary}
              data-study-punctuation=""
              style={{ whiteSpace: 'nowrap' }}
            >
              {piece}
            </span>
          ) : (
            piece
          ),
        )}
      </span>
    ) : (
      part
    ),
  );
});
