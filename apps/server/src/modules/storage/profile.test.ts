// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
} from './profile.js';

describe('parseStorageProfile', () => {
  it('defaults both axes to disk', () => {
    expect(parseStorageProfile({})).toEqual({
      structured: { kind: 'disk' },
      blobs: { kind: 'disk' },
    });
  });

  it('reads each axis independently', () => {
    const profile = parseStorageProfile({
      HUABU_STRUCTURED_BACKEND: 'postgres',
      HUABU_BLOB_BACKEND: 'azure',
    });
    expect(profile.structured.kind).toBe('postgres');
    expect(profile.blobs.kind).toBe('azure');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(
      parseStorageProfile({ HUABU_BLOB_BACKEND: '  Azure ' }).blobs.kind,
    ).toBe('azure');
  });

  it('names the supported set when a kind is unknown', () => {
    expect(() => parseStorageProfile({ HUABU_BLOB_BACKEND: 's3' })).toThrow(
      /HUABU_BLOB_BACKEND="s3".*disk, azure/s,
    );
  });

  it('rejects a structured kind from the blob axis', () => {
    expect(() =>
      parseStorageProfile({ HUABU_BLOB_BACKEND: 'postgres' }),
    ).toThrow(StorageProfileError);
  });
});

describe('validateStorageProfile', () => {
  it('accepts the disk + disk profile', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'disk' },
        blobs: { kind: 'disk' },
      }),
    ).not.toThrow();
  });

  // A kind can be a known member of the target family while having no
  // adapter yet. That must fail at startup, not on first use.
  it('rejects a known but unimplemented structured backend', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'postgres' },
        blobs: { kind: 'disk' },
      }),
    ).toThrow(/not implemented yet.*disk/s);
  });

  it('rejects a known but unimplemented blob backend', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'disk' },
        blobs: { kind: 'azure' },
      }),
    ).toThrow(/not implemented yet.*disk/s);
  });
});

describe('requiresExplicitInit', () => {
  // The on-demand path in `storage.ts` is synchronous and so cannot await
  // `init()`. Disk has nothing to open, which is why that path is legal at
  // all; every backend that holds a connection must go through
  // `initStorage()` instead of being built on first use.
  it('allows the disk + disk profile to be built on demand', () => {
    expect(
      requiresExplicitInit({
        structured: { kind: 'disk' },
        blobs: { kind: 'disk' },
      }),
    ).toBe(false);
  });

  it.each([
    { structured: { kind: 'postgres' }, blobs: { kind: 'disk' } },
    { structured: { kind: 'sqlite' }, blobs: { kind: 'disk' } },
    { structured: { kind: 'disk' }, blobs: { kind: 'azure' } },
  ] as const)('requires an awaited init for %j', (profile) => {
    expect(requiresExplicitInit(profile)).toBe(true);
  });
});
