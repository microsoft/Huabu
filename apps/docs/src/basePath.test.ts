// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveWithBasePath } from './basePath';
import { normalizeBasePath } from './normalizeBasePath';

describe('normalizeBasePath', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['ExampleProject', '/ExampleProject/'],
    ['/ExampleProject/', '/ExampleProject/'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe('resolveWithBasePath', () => {
  it('prefixes a root-relative path with the configured base', () => {
    expect(resolveWithBasePath('/ExampleProject/', '/docs/quickstart')).toBe(
      '/ExampleProject/docs/quickstart',
    );
  });

  it('does not prefix an already resolved path again', () => {
    expect(
      resolveWithBasePath(
        '/ExampleProject/',
        '/ExampleProject/docs/quickstart',
      ),
    ).toBe('/ExampleProject/docs/quickstart');
  });

  it('keeps root deployments root-relative', () => {
    expect(resolveWithBasePath('/', 'docs/quickstart')).toBe(
      '/docs/quickstart',
    );
  });
});
