// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { normalizeSafeLinkHref, parseSafeLinkUrl } from './safeLink';

describe('safe link boundaries', () => {
  it('preserves trimmed invocation text while providing canonical URL identity', () => {
    const raw = '  HTTPS://Example.COM:443/a/../docs?q=1#part  ';
    expect(normalizeSafeLinkHref(raw)).toBe(
      'HTTPS://Example.COM:443/a/../docs?q=1#part',
    );
    expect(parseSafeLinkUrl(raw)?.href).toBe(
      'https://example.com/docs?q=1#part',
    );
  });

  it.each([
    null,
    undefined,
    '',
    '  ',
    '/relative',
    'broken',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///tmp/a',
    'mailto:a@example.com',
  ])('rejects unsafe or missing input: %s', (raw) => {
    expect(normalizeSafeLinkHref(raw)).toBeNull();
    expect(parseSafeLinkUrl(raw)).toBeNull();
  });

  it.each(['http://example.com', 'https://example.com/path?q=1#part'])(
    'accepts HTTP(S) links: %s',
    (raw) => {
      expect(normalizeSafeLinkHref(raw)).toBe(raw);
      expect(parseSafeLinkUrl(raw)?.href).toBe(new URL(raw).href);
    },
  );
});
