// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { parseTabNavigation, parseTabSession, tabUrl } from './tab-session.js';

describe('desktop Tab session contract', () => {
  it('deduplicates restored Spaces and repairs a stale active identity', () => {
    expect(
      parseTabSession({
        canvasIds: ['a', 'b', 'a'],
        activeCanvasId: 'deleted',
      }),
    ).toEqual({ canvasIds: ['a', 'b'], activeCanvasId: null, titles: {} });
  });

  it('restores optional title snapshots without requiring them in older sessions', () => {
    expect(
      parseTabSession({
        canvasIds: ['a', 'b'],
        activeCanvasId: 'a',
        titles: { a: 'Alpha', b: 'Beta' },
      }).titles,
    ).toEqual({ a: 'Alpha', b: 'Beta' });
  });

  it.each([
    null,
    {},
    { canvasIds: ['../bad'], activeCanvasId: null },
    { canvasIds: [17], activeCanvasId: null },
    { canvasIds: ['a'], activeCanvasId: null, titles: null },
    { canvasIds: ['a'], activeCanvasId: null, titles: [] },
    { canvasIds: ['a'], activeCanvasId: null, titles: { a: 17 } },
    { canvasIds: ['a'], activeCanvasId: null, titles: { a: 'x'.repeat(513) } },
    { canvasIds: ['a'], activeCanvasId: null, titles: { '../bad': 'Bad' } },
  ])('rejects malformed stored session %j', (raw) =>
    expect(() => parseTabSession(raw)).toThrow(),
  );

  it('preserves node navigation and one-shot router state', () => {
    const target = {
      canvasId: 'space a',
      search: '?node=n1',
      hash: '#section',
      state: { previewNode: { canvasId: 'space a', nodeId: 'n1' } },
    };
    expect(parseTabNavigation(target)).toEqual(expect.objectContaining(target));
    expect(tabUrl('http://localhost:5173', target)).toBe(
      'http://localhost:5173/canvas/space%20a?node=n1#section',
    );
  });

  it.each([
    { canvasId: 'https://evil.example' },
    { canvasId: '../outside' },
    { canvasId: 'a', search: 'https://evil.example' },
    { canvasId: null, homePath: '/api/workspace' },
    { canvasId: 'a', state: 'x'.repeat(65_536) },
  ])('rejects invalid navigation %j', (target) => {
    expect(() => parseTabNavigation(target)).toThrow();
  });

  it('constructs Home and Setup on the selected origin only', () => {
    expect(tabUrl('https://huabu.example', { canvasId: null })).toBe(
      'https://huabu.example/spaces',
    );
    expect(
      tabUrl('https://huabu.example', { canvasId: null, homePath: '/setup' }),
    ).toBe('https://huabu.example/setup');
  });
});
