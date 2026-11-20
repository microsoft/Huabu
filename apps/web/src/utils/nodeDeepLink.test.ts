// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  buildNodeDeepLink,
  buildNodeReferenceHref,
  parseNodeReferenceHref,
  readNodeDeepLinkIntent,
} from './nodeDeepLink';

describe('node deep links', () => {
  it('builds the canonical stable-id URL without carrying unrelated state', () => {
    expect(
      buildNodeDeepLink(
        'https://huabu.example/path?old=1#fragment',
        'canvas-a/b',
        'node-123',
      ),
    ).toBe('https://huabu.example/canvas/canvas-a%2Fb?node=node-123');
  });

  it('reads one valid node target', () => {
    expect(readNodeDeepLinkIntent('?node=node-123')).toEqual({
      kind: 'target',
      nodeId: 'node-123',
    });
  });

  it('leaves ordinary Space URLs unchanged', () => {
    expect(readNodeDeepLinkIntent('?other=value')).toEqual({ kind: 'none' });
  });

  it.each([
    '?node=',
    '?node=bad',
    '?node=node-1&node=node-2',
    `?node=node-${'a'.repeat(252)}`,
  ])('rejects malformed or ambiguous targets: %s', (search) => {
    expect(readNodeDeepLinkIntent(search)).toEqual({ kind: 'invalid' });
  });
});

describe('in-document node references', () => {
  const origin = 'https://huabu.example';

  it('round-trips the Space-relative form', () => {
    const href = buildNodeReferenceHref('node-123');
    expect(href).toBe('#node-123');
    expect(parseNodeReferenceHref(`  ${href} `, origin)).toEqual({
      nodeId: 'node-123',
    });
  });

  it('reads a same-origin deep link with its Space', () => {
    expect(
      parseNodeReferenceHref(
        buildNodeDeepLink(origin, 'canvas-a/b', 'node-123'),
        origin,
      ),
    ).toEqual({ canvasId: 'canvas-a/b', nodeId: 'node-123' });
  });

  it('reads a root-relative deep link', () => {
    expect(
      parseNodeReferenceHref('/canvas/canvas-a?node=node-123', origin),
    ).toEqual({ canvasId: 'canvas-a', nodeId: 'node-123' });
  });

  it.each([
    null,
    '',
    '#section',
    'canvas/c?node=node-123',
    '//other.example/canvas/c?node=node-123',
    '#node-',
    'node-123',
    'javascript:alert(1)#node-123',
    'https://other.example/canvas/c?node=node-123',
    'https://huabu.example/canvas/c',
    'https://huabu.example/other/c?node=node-123',
    'https://huabu.example/canvas/c?node=node-1&node=node-2',
  ])('treats %j as an ordinary link', (href) => {
    expect(parseNodeReferenceHref(href, origin)).toBeNull();
  });
});
