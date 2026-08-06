// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveHandbookUrl, validateHandbookUrl } from './handbook';

describe('resolveHandbookUrl', () => {
  it('requires an explicitly configured URL in production', () => {
    expect(() => resolveHandbookUrl(undefined, true)).toThrow(
      /VITE_HANDBOOK_URL is required/,
    );
  });

  it('uses the current web origin during development', () => {
    expect(resolveHandbookUrl(undefined, false, 'http://127.0.0.1:6182')).toBe(
      'http://127.0.0.1:6182/docs/',
    );
  });

  it('prefers an explicitly configured URL', () => {
    expect(
      resolveHandbookUrl(' https://microsoft.github.io/Huabu/docs/ ', true),
    ).toBe('https://microsoft.github.io/Huabu/docs/');
  });
});

describe('validateHandbookUrl', () => {
  it('normalizes an HTTPS handbook URL', () => {
    expect(validateHandbookUrl('https://example.com/docs', true)).toBe(
      'https://example.com/docs/',
    );
  });

  it('allows HTTP loopback hosts only during development', () => {
    expect(validateHandbookUrl('http://localhost:5174/docs', false)).toBe(
      'http://localhost:5174/docs/',
    );
    expect(validateHandbookUrl('http://127.0.0.1:5174/docs', false)).toBe(
      'http://127.0.0.1:5174/docs/',
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
