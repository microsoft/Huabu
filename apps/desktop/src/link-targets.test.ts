// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { classifyLink } from './link-targets';

const ORIGIN = 'http://127.0.0.1:3001';

it.each([
  [`${ORIGIN}/`, 'application'],
  [`${ORIGIN}/spaces`, 'application'],
  [`${ORIGIN}/canvas/one?node=a`, 'application'],
  [`${ORIGIN}/api/canvas/one/artifact/shot.png`, 'image'],
  [`${ORIGIN}/api/canvas/one/artifact/dir/photo.JPEG?v=2`, 'image'],
  // A document that can run script is never opened as a page of the app.
  [`${ORIGIN}/api/canvas/one/artifact/drawing.svg`, 'file'],
  [`${ORIGIN}/api/canvas/one/artifact/page.html`, 'file'],
  [`${ORIGIN}/api/canvas/one/artifact/report.pdf`, 'file'],
  [`${ORIGIN}/api/workspace`, 'file'],
  // The image suffix must be the path's own, not a query's or another route's.
  [`${ORIGIN}/api/canvas/one/artifact/page.html?x=.png`, 'file'],
  [`${ORIGIN}/api/other/one/artifact/shot.png`, 'file'],
  ['https://example.com/shot.png', 'external'],
  ['http://127.0.0.1:9999/api/canvas/one/artifact/shot.png', 'external'],
  ['file:///etc/passwd', 'none'],
  ['javascript:alert(1)', 'none'],
  ['not a url', 'none'],
])('classifies %s as %s', (url, expected) => {
  expect(classifyLink(url, ORIGIN)).toBe(expected);
});
