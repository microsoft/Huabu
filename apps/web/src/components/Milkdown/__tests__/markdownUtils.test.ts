import { describe, expect, it } from 'vitest';

import {
  ensureNonEmpty,
  markdownEquals,
  normalizeMarkdown,
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
