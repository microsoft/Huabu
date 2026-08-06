// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the RFS node-metadata header serialiser.
 *
 * `rfsMetaHeaders` is pure, so it is exercised directly without seeding a
 * canvas on disk: the interesting behaviour is the Unicode-safe label encoding
 * and the compact parent/child edges JSON that ride in the `X-Huabu-*` headers.
 */

import { describe, expect, it } from 'vitest';

import { RFS_HEADERS } from '@huabu/shared';

import { rfsMetaHeaders } from './node-meta.js';

describe('rfsMetaHeaders', () => {
  it('percent-encodes a Unicode label and serialises edges as JSON', () => {
    const headers = rfsMetaHeaders({
      meta: { id: 'n1', type: 'note', label: '我的笔记 / draft', locked: true },
      edges: { parents: ['p1'], children: ['c1', 'c2'] },
    });

    expect(headers[RFS_HEADERS.nodeId]).toBe('n1');
    expect(headers[RFS_HEADERS.nodeType]).toBe('note');
    expect(headers[RFS_HEADERS.locked]).toBe('true');
    // Label is percent-encoded UTF-8 — ASCII-safe on the wire, URL-decodable.
    const label = headers[RFS_HEADERS.nodeLabel] ?? '';
    expect(label).toBe('%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0%20%2F%20draft');
    expect(decodeURIComponent(label)).toBe('我的笔记 / draft');
    expect(JSON.parse(headers[RFS_HEADERS.edges] ?? '')).toEqual({
      parents: ['p1'],
      children: ['c1', 'c2'],
    });
  });

  it('omits optional label/src but always emits edges', () => {
    const headers = rfsMetaHeaders({
      meta: { id: 'n2', type: 'note' },
      edges: { parents: [], children: [] },
    });

    expect(headers[RFS_HEADERS.nodeLabel]).toBeUndefined();
    expect(headers[RFS_HEADERS.src]).toBeUndefined();
    expect(headers[RFS_HEADERS.locked]).toBeUndefined();
    expect(headers[RFS_HEADERS.edges]).toBe('{"parents":[],"children":[]}');
  });
});
