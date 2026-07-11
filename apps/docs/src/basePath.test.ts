import { describe, expect, it } from 'vitest';

import { resolveWithBasePath } from './basePath';
import { normalizeBasePath } from './normalizeBasePath';

describe('normalizeBasePath', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['Sediment', '/Sediment/'],
    ['/Sediment/', '/Sediment/'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe('resolveWithBasePath', () => {
  it('prefixes a root-relative path with the configured base', () => {
    expect(resolveWithBasePath('/Sediment/', '/docs/quickstart')).toBe(
      '/Sediment/docs/quickstart',
    );
  });

  it('does not prefix an already resolved path again', () => {
    expect(resolveWithBasePath('/Sediment/', '/Sediment/docs/quickstart')).toBe(
      '/Sediment/docs/quickstart',
    );
  });

  it('keeps root deployments root-relative', () => {
    expect(resolveWithBasePath('/', 'docs/quickstart')).toBe(
      '/docs/quickstart',
    );
  });
});
