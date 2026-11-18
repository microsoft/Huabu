// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { deviceFileName } from './deviceFile';

it.each([
  ['/Users/me/notes.md', 'notes.md'],
  ['C:\\Users\\me', 'me'],
  ['C:/Users/me', 'me'],
  ['/tmp/a\\b.txt', 'a\\b.txt'],
  ['/', '/'],
])('names %s by its last segment', (path, name) => {
  expect(deviceFileName(path)).toBe(name);
});
