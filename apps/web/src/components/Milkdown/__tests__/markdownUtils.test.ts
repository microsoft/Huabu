// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  ensureNonEmpty,
  markdownEquals,
  normalizeMarkdown,
  normalizeMathDelimiters,
} from '../markdownUtils';

describe('normalizeMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeMarkdown('')).toBe('');
  });

  it('converts CRLF to LF', () => {
    expect(normalizeMarkdown('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('converts lone CR to LF', () => {
    expect(normalizeMarkdown('a\rb\rc')).toBe('a\nb\nc');
  });

  it('strips trailing spaces on a single-content line', () => {
    expect(normalizeMarkdown('hello   ')).toBe('hello');
  });

  it('preserves the two-space hard-break marker', () => {
    // `hello  ` followed by `world` is a markdown hard break.
    expect(normalizeMarkdown('hello  \nworld')).toBe('hello  \nworld');
  });

  it('collapses 3+ trailing spaces to the hard-break marker', () => {
    expect(normalizeMarkdown('hello     \nworld')).toBe('hello  \nworld');
  });

  it('trims pure whitespace lines completely', () => {
    expect(normalizeMarkdown('a\n   \nb')).toBe('a\n\nb');
  });

  it('preserves leading indentation', () => {
    expect(normalizeMarkdown('  - item\n    - nested')).toBe(
      '  - item\n    - nested',
    );
  });

  it('strips trailing blank lines', () => {
    expect(normalizeMarkdown('hello\n\n\n')).toBe('hello');
  });

  it('handles mixed line endings + trailing blanks together', () => {
    expect(normalizeMarkdown('a\r\nb  \r\n   \r\n\r\n')).toBe('a\nb');
  });
});

describe('ensureNonEmpty', () => {
  it('replaces empty input with a single newline', () => {
    expect(ensureNonEmpty('')).toBe('\n');
  });

  it('replaces whitespace-only input with a single newline', () => {
    expect(ensureNonEmpty('   \n\t\n  ')).toBe('\n');
  });

  it('returns non-empty input unchanged', () => {
    expect(ensureNonEmpty('hello')).toBe('hello');
  });

  it('returns input that contains only meaningful whitespace', () => {
    // Leading-space line is meaningful markdown (indented code).
    expect(ensureNonEmpty('    code\n')).toBe('    code\n');
  });
});

describe('markdownEquals', () => {
  it('treats identical strings as equal', () => {
    expect(markdownEquals('foo', 'foo')).toBe(true);
  });

  it('treats CRLF and LF variants as equal', () => {
    expect(markdownEquals('a\r\nb', 'a\nb')).toBe(true);
  });

  it('ignores trailing whitespace differences', () => {
    expect(markdownEquals('hello   ', 'hello')).toBe(true);
  });

  it('ignores trailing blank lines', () => {
    expect(markdownEquals('hello\n\n\n', 'hello')).toBe(true);
  });

  it('distinguishes semantically different content', () => {
    expect(markdownEquals('hello', 'world')).toBe(false);
  });

  it('preserves the hard-break marker as significant', () => {
    expect(markdownEquals('a  \nb', 'a\nb')).toBe(false);
  });
});

describe('normalizeMathDelimiters', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeMathDelimiters('')).toBe('');
  });

  it('converts a standalone block math span to multi-line $$ form', () => {
    const input = '\\[ x^2 + y^2 = z^2 \\]';
    // The helper always emits the canonical paragraph-form block math
    // (surrounding blank lines) so `remark-math` recognises it as
    // display math regardless of context.
    expect(normalizeMathDelimiters(input)).toBe(
      '\n\n$$\nx^2 + y^2 = z^2\n$$\n\n',
    );
  });

  it('converts a multi-line block math span and trims inner whitespace', () => {
    const input = '\\[\nx^2 + y^2 = z^2\n\\]';
    expect(normalizeMathDelimiters(input)).toBe(
      '\n\n$$\nx^2 + y^2 = z^2\n$$\n\n',
    );
  });

  it('converts a block math span embedded in paragraph text', () => {
    const input = 'Pythagoras:\n\n\\[ a^2 + b^2 = c^2 \\]\n\nThat is it.';
    expect(normalizeMathDelimiters(input)).toBe(
      'Pythagoras:\n\n$$\na^2 + b^2 = c^2\n$$\n\nThat is it.',
    );
  });

  it('converts inline math \\(…\\) to $…$', () => {
    expect(normalizeMathDelimiters('Let \\( x = 1 \\) and go.')).toBe(
      'Let $ x = 1 $ and go.',
    );
  });

  it('converts multiple inline math spans on the same line', () => {
    expect(
      normalizeMathDelimiters('Pairs \\( a \\) and \\( b \\) differ.'),
    ).toBe('Pairs $ a $ and $ b $ differ.');
  });

  it('converts mixed block and inline math in the same document', () => {
    const input = 'Given \\( x = 1 \\), then\n\n\\[ x + 1 = 2 \\]\n';
    expect(normalizeMathDelimiters(input)).toBe(
      'Given $ x = 1 $, then\n\n$$\nx + 1 = 2\n$$\n\n',
    );
  });

  it('leaves content inside fenced code blocks untouched', () => {
    const input = '```\n\\[ x \\] and \\( y \\)\n```';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('does not mutate fenced code blocks even with multiple blank lines', () => {
    const input = '```\nline 1\n\n\nline 2\n```';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('leaves content inside tilde-fenced code blocks untouched', () => {
    const input = '~~~\n\\[ x \\] and \\( y \\)\n~~~';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('still rewrites math outside the code fence', () => {
    const input = '\\( x \\)\n\n```\n\\[ y \\]\n```\n\n\\[ z \\]';
    expect(normalizeMathDelimiters(input)).toBe(
      '$ x $\n\n```\n\\[ y \\]\n```\n\n$$\nz\n$$\n\n',
    );
  });

  it('leaves content inside inline code spans untouched', () => {
    const input = 'Use `\\[ x \\]` for display math, e.g. \\( y \\).';
    expect(normalizeMathDelimiters(input)).toBe(
      'Use `\\[ x \\]` for display math, e.g. $ y $.',
    );
  });

  it('does not rewrite an unpaired opening delimiter (streaming chunk)', () => {
    expect(normalizeMathDelimiters('partial \\[ x + y')).toBe(
      'partial \\[ x + y',
    );
    expect(normalizeMathDelimiters('inline \\( half')).toBe('inline \\( half');
  });

  it('completes the rewrite once the closing delimiter arrives', () => {
    const partial = 'partial \\[ x + y';
    const complete = partial + ' \\]';
    // Mid-paragraph block math is uncommon in AI output, but when it
    // happens we still emit block form. The injected paragraph break
    // splits the text into a `partial` paragraph and a block math
    // paragraph, which is the correct rendering for `remark-math`.
    expect(normalizeMathDelimiters(complete)).toBe(
      'partial \n\n$$\nx + y\n$$\n\n',
    );
  });

  it('does not let \\( … \\) swallow paragraphs across newlines', () => {
    const input = 'open \\( and then\n\nanother paragraph \\) close';
    // The opener and closer are on different lines, so nothing matches.
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('keeps two adjacent block formulas separate', () => {
    const input = '\\[ a \\]\n\n\\[ b \\]';
    expect(normalizeMathDelimiters(input)).toBe(
      '\n\n$$\na\n$$\n\n$$\nb\n$$\n\n',
    );
  });

  it('is a no-op on already-canonical $$ / $ markdown', () => {
    const input = 'See $x = 1$ and\n\n$$\nx^2\n$$\n';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('canonicalises multi-line $$…$$ whose fences are not on their own lines', () => {
    // remark-math rejects this shape (fences must sit on their own
    // lines for block math). AI assistants emit it frequently when
    // wrapping a `\begin{aligned}` environment.
    const input = [
      '$$\\begin{aligned}',
      '(r_i, a_i) &\\sim \\pi_\\theta(\\cdot \\mid S, q, h_{i-1}), \\\\',
      'o_i &= e(a_i, h_{i-1}), \\\\',
      'h_i &= h_{i-1} \\circ (r_i, a_i, o_i).',
      '\\end{aligned}$$',
    ].join('\n');
    const expected = [
      '',
      '',
      '$$',
      '\\begin{aligned}',
      '(r_i, a_i) &\\sim \\pi_\\theta(\\cdot \\mid S, q, h_{i-1}), \\\\',
      'o_i &= e(a_i, h_{i-1}), \\\\',
      'h_i &= h_{i-1} \\circ (r_i, a_i, o_i).',
      '\\end{aligned}',
      '$$',
      '',
      '',
    ].join('\n');
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it('canonicalising multi-line $$…$$ is idempotent', () => {
    const input = '$$\\begin{aligned}\na &= b\n\\end{aligned}$$';
    const once = normalizeMathDelimiters(input);
    expect(normalizeMathDelimiters(once)).toBe(once);
  });

  it('leaves single-line $$x$$ untouched (already valid inline block math)', () => {
    const input = 'See $$x^2 + y^2$$ done.';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('does not rewrite multi-line $$ inside a fenced code block', () => {
    const input = '```\n$$\\begin{aligned}\na = b\n\\end{aligned}$$\n```';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('is idempotent', () => {
    const input = 'Given \\( x \\), \\[ x^2 \\].';
    const once = normalizeMathDelimiters(input);
    expect(normalizeMathDelimiters(once)).toBe(once);
  });
});
