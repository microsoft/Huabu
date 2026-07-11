import { describe, expect, it } from 'vitest';

import { validateHandbookUrl } from './handbook';

describe('validateHandbookUrl', () => {
  it('normalizes an HTTPS handbook URL', () => {
    expect(validateHandbookUrl('https://example.com/docs', true)).toBe(
      'https://example.com/docs/',
    );
  });

  it('allows HTTP localhost only during development', () => {
    expect(validateHandbookUrl('http://localhost:5174/docs', false)).toBe(
      'http://localhost:5174/docs/',
    );
    expect(() =>
      validateHandbookUrl('http://localhost:5174/docs', true),
    ).toThrow(/HTTPS/);
  });

  it('rejects unsafe or relative URLs', () => {
    expect(() => validateHandbookUrl('/docs', false)).toThrow(/absolute/);
    expect(() => validateHandbookUrl('javascript:alert(1)', false)).toThrow(
      /HTTPS/,
    );
  });
});
