// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {},
  session: {},
  shell: {},
  WebContentsView: class {},
}));

import { parsePageRect, placeWithin, previewUrl } from './page-previews';

const APP = 'http://127.0.0.1:3001';

describe('previewUrl', () => {
  it('accepts another site’s web page', () => {
    expect(previewUrl('https://example.com/a?b=1#c', APP)).toBe(
      'https://example.com/a?b=1#c',
    );
    expect(previewUrl('http://example.com', APP)).toBe('http://example.com/');
  });

  it.each([
    ['the application itself', `${APP}/canvas/one`],
    ['a stored document', `${APP}/api/canvas/one/artifact/page.html`],
    ['a file', 'file:///etc/passwd'],
    ['a script', 'javascript:alert(1)'],
    ['inline data', 'data:text/html,<p>hi</p>'],
    ['a browser page', 'chrome://settings'],
    ['a relative address', '/canvas/one'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(previewUrl(url, APP)).toBeNull();
  });

  it('refuses anything that is not a string, or is absurdly long', () => {
    expect(previewUrl(undefined, APP)).toBeNull();
    expect(previewUrl({ href: 'https://example.com' }, APP)).toBeNull();
    expect(
      previewUrl(`https://example.com/${'a'.repeat(9000)}`, APP),
    ).toBeNull();
  });
});

describe('parsePageRect', () => {
  it('reads a rectangle', () => {
    expect(
      parsePageRect({ x: 1, y: 2, width: 3, height: 4, extra: 5 }),
    ).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it.each([
    null,
    'rect',
    { x: 1, y: 2, width: 3 },
    { x: 1, y: 2, width: 3, height: '4' },
    { x: Number.NaN, y: 2, width: 3, height: 4 },
    { x: 1, y: 2, width: Number.POSITIVE_INFINITY, height: 4 },
  ])('refuses %j', (raw) => {
    expect(parsePageRect(raw)).toBeNull();
  });
});

describe('placeWithin', () => {
  const frame = { x: 0, y: 36, width: 1400, height: 864 };

  it('offsets the page by where its owner sits in the window', () => {
    expect(
      placeWithin({ x: 980, y: 84, width: 420, height: 780 }, 1, frame),
    ).toEqual({ x: 980, y: 120, width: 420, height: 780 });
  });

  it('scales by the owner’s zoom', () => {
    expect(
      placeWithin({ x: 100, y: 50, width: 200, height: 100 }, 1.5, frame),
    ).toEqual({ x: 150, y: 111, width: 300, height: 150 });
  });

  it('never leaves the owner, so it cannot cover the title bar', () => {
    expect(
      placeWithin({ x: -50, y: -100, width: 2000, height: 2000 }, 1, frame),
    ).toEqual(frame);
  });

  it('is nowhere when nothing of it would show', () => {
    expect(
      placeWithin({ x: 1500, y: 0, width: 100, height: 100 }, 1, frame),
    ).toBeNull();
    expect(
      placeWithin({ x: 10, y: 10, width: 0, height: 100 }, 1, frame),
    ).toBeNull();
  });
});
