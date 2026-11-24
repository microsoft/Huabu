// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openImageViewer: vi.fn() }));
vi.mock('./image-viewer.js', () => ({
  openImageViewer: mocks.openImageViewer,
}));

import { openServerFile } from './server-files';

import type { WebContents } from 'electron';

const ORIGIN = 'http://127.0.0.1:3001';
const sender = { downloadURL: vi.fn() };
const open = (url: unknown) =>
  openServerFile(url, sender as unknown as WebContents, ORIGIN);

beforeEach(() => vi.clearAllMocks());

it('shows a stored raster image in the app and saves any other stored file', () => {
  open('/api/canvas/a/artifact/shot.png');
  expect(mocks.openImageViewer).toHaveBeenCalledWith(
    `${ORIGIN}/api/canvas/a/artifact/shot.png`,
    sender,
  );
  open(`${ORIGIN}/api/canvas/a/artifact/report.pdf`);
  // A document that can run script is saved, never opened as a page.
  open(`${ORIGIN}/api/canvas/a/artifact/page.html`);
  open(`${ORIGIN}/api/canvas/a/artifact/drawing.svg`);
  expect(sender.downloadURL.mock.calls.map(([url]) => url)).toEqual([
    `${ORIGIN}/api/canvas/a/artifact/report.pdf`,
    `${ORIGIN}/api/canvas/a/artifact/page.html`,
    `${ORIGIN}/api/canvas/a/artifact/drawing.svg`,
  ]);
  expect(mocks.openImageViewer).toHaveBeenCalledTimes(1);
});

it.each([
  'https://example.com/shot.png',
  'http://127.0.0.1:9999/api/canvas/a/artifact/shot.png',
  `${ORIGIN}/canvas/a`,
  'file:///etc/passwd',
  'javascript:alert(1)',
  '',
  42,
  null,
  `${ORIGIN}/${'a'.repeat(5000)}`,
])('refuses %j', (url) => {
  expect(() => open(url)).toThrow();
  expect(mocks.openImageViewer).not.toHaveBeenCalled();
  expect(sender.downloadURL).not.toHaveBeenCalled();
});
