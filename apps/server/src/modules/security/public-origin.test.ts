// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  normalizePublicOrigin,
  resolveConfiguredPublicOrigin,
} from './public-origin.js';

describe('public origin', () => {
  it.each([
    ['https://huabu.example.com', 'https://huabu.example.com'],
    ['https://huabu.example.com:8443/', 'https://huabu.example.com:8443'],
    ['http://192.168.1.50:3001', 'http://192.168.1.50:3001'],
    ['https://[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePublicOrigin(input)).toBe(expected);
  });

  it.each([
    'ftp://huabu.example.com',
    'https://owner:secret@huabu.example.com',
    'https://huabu.example.com/base',
    'https://huabu.example.com?mode=remote',
    'https://huabu.example.com#remote',
    'not-a-url',
  ])('rejects unsafe or non-origin value %s', (input) => {
    expect(() => normalizePublicOrigin(input)).toThrow(/HUABU_PUBLIC_ORIGIN/);
  });

  it('treats an empty setting as unconfigured', () => {
    expect(resolveConfiguredPublicOrigin({ HUABU_PUBLIC_ORIGIN: '  ' })).toBe(
      undefined,
    );
  });
});
