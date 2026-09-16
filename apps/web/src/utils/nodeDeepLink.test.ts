// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildNodeDeepLink, readNodeDeepLinkIntent } from './nodeDeepLink';

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
