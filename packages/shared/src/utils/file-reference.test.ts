// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isFileReference } from './file-reference.js';
import { fileReferenceSchema } from '../types/api/device-files.js';

describe('zod-free file-reference validation', () => {
  it.each([
    { agentletId: 'device', path: '/home/user/source.tex' },
    {
      agentletId: 'device',
      path: 'C:\\Users\\source.txt',
      deviceName: 'Windows',
    },
    { agentletId: 'device', path: '\\\\host\\share\\file' },
    { agentletId: '', path: '/file' },
    { agentletId: 'device', path: 'relative/path' },
    { agentletId: 'device', path: '/file\u0000' },
    { agentletId: 'device', path: '/file', deviceName: 'x'.repeat(513) },
    { agentletId: 'device', path: '/file', token: 'forbidden' },
    null,
    [],
    'file',
  ])('matches the canonical metadata-only wire schema for %j', (value) => {
    expect(isFileReference(value)).toBe(
      fileReferenceSchema.safeParse(value).success,
    );
  });
});
