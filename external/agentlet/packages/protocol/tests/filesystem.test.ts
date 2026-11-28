// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';
import {
  FS_MAX_BINARY_BYTES,
  FS_PROXY_CAPABILITY,
  FS_PROXY_CAPABILITY_KEY,
  parseFsRequest,
  supportsFsBinaryRead,
  supportsFsProtocol,
} from '../src/filesystem.js';

describe('filesystem initialization capability', () => {
  it('declares the fixed v1 read-only filesystem contract and binaryRead extension', () => {
    expect(FS_PROXY_CAPABILITY_KEY).toBe('com.microsoft.agentlet/filesystem');
    expect(FS_PROXY_CAPABILITY).toEqual({ version: 1, binaryRead: true });
    expect(Object.isFrozen(FS_PROXY_CAPABILITY)).toBe(true);
    expect(
      supportsFsProtocol({
        loadSession: false,
        _meta: {
          unrelated: true,
          [FS_PROXY_CAPABILITY_KEY]: FS_PROXY_CAPABILITY,
        },
      }),
    ).toBe(true);
    expect(
      supportsFsBinaryRead({
        loadSession: false,
        _meta: {
          unrelated: true,
          [FS_PROXY_CAPABILITY_KEY]: FS_PROXY_CAPABILITY,
        },
      }),
    ).toBe(true);
    // Legacy v1 proxies remain valid for directory listing and UTF-8 text reads.
    expect(
      supportsFsProtocol({
        _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 1 } },
      }),
    ).toBe(true);
    expect(
      supportsFsBinaryRead({
        _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 1 } },
      }),
    ).toBe(false);
    expect(
      supportsFsBinaryRead({
        _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 1, binaryRead: false } },
      }),
    ).toBe(false);
  });

  it.each([
    undefined,
    null,
    false,
    1,
    'filesystem',
    [],
    {},
    { _meta: null },
    { _meta: false },
    { _meta: 'v1' },
    { _meta: [] },
    { [FS_PROXY_CAPABILITY_KEY]: { version: 1 } },
    { fs: { readTextFile: true } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: null } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: true } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: '1' } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: [] } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: {} } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: '1' } } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 0 } } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 2 } } },
    { _meta: { [FS_PROXY_CAPABILITY_KEY]: { version: 1, binaryRead: 'yes' } } },
  ])('rejects missing, malformed or unsupported capability %j', (value) => {
    expect(supportsFsProtocol(value)).toBe(false);
    expect(supportsFsBinaryRead(value)).toBe(false);
  });

  it('validates fs-read-bytes limits and maxSizeBytes', () => {
    expect(
      parseFsRequest('fs-read-bytes', {
        path: '/work/doc.pdf',
        limitBytes: FS_MAX_BINARY_BYTES,
        maxSizeBytes: 33_554_432,
      }),
    ).toEqual({
      path: '/work/doc.pdf',
      limitBytes: FS_MAX_BINARY_BYTES,
      maxSizeBytes: 33_554_432,
    });
    expect(() =>
      parseFsRequest('fs-read-bytes', { path: '/work/doc.pdf', limitBytes: 0 }),
    ).toThrow();
    expect(() =>
      parseFsRequest('fs-read-bytes', {
        path: '/work/doc.pdf',
        limitBytes: FS_MAX_BINARY_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      parseFsRequest('fs-read-bytes', {
        path: '/work/doc.pdf',
        maxSizeBytes: 0,
      }),
    ).toThrow();
    expect(() =>
      parseFsRequest('fs-read', { path: '/work/doc.txt', maxSizeBytes: 1024 }),
    ).toThrow();
  });
});
