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
  it('defaults both backend axes to disk, and files to their pairing', () => {
    expect(parseStorageProfile({})).toEqual({
      structured: { kind: 'disk' },
      blobs: { kind: 'disk' },
      files: { kind: 'disk-titled' },
    });
  });

  it('derives the materialization from the structured backend', () => {
    // Not a knob: a structured backend that owns directories has already
    // chosen where a Space lives, and the materialization has to agree.
    expect(
      parseStorageProfile({ HUABU_STRUCTURED_BACKEND: 'sqlite' }).files.kind,
    ).toBe('disk-addressed');
    expect(
      parseStorageProfile({ HUABU_STRUCTURED_BACKEND: 'disk' }).files.kind,
    ).toBe('disk-titled');
  });

  it('ignores an environment attempt to choose the materialization', () => {
    expect(
      parseStorageProfile({ HUABU_SPACE_FILES: 'disk-addressed' }).files.kind,
    ).toBe('disk-titled');
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
        files: { kind: 'disk-titled' },
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
        files: { kind: 'disk-titled' },
      }),
    ).toThrow(/not implemented yet.*disk/s);
  });

  it('rejects a known but unimplemented blob backend', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'disk' },
        blobs: { kind: 'azure' },
        files: { kind: 'disk-titled' },
      }),
    ).toThrow(/not implemented yet.*disk/s);
  });

  // The pairing guards a quiet failure rather than a crash: Disk's records
  // live under the title, so id-addressed materialization would put a
  // Space's blobs in one directory and its records in another, with neither
  // looking wrong on its own.
  it('rejects a materialization the structured backend did not choose', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'disk' },
        blobs: { kind: 'disk' },
        files: { kind: 'disk-addressed' },
      }),
    ).toThrow(/requires the "disk-titled" Space materialization/);
  });

  it('reports a missing adapter ahead of the pairing it would also fail', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'sqlite' },
        blobs: { kind: 'disk' },
        files: { kind: 'disk-titled' },
      }),
    ).toThrow(/Structured backend "sqlite" is not implemented yet/);
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
        files: { kind: 'disk-titled' },
      }),
    ).toBe(false);
  });

  it.each([
    {
      structured: { kind: 'postgres' },
      blobs: { kind: 'disk' },
      files: { kind: 'disk-titled' },
    },
    {
      structured: { kind: 'sqlite' },
      blobs: { kind: 'disk' },
      files: { kind: 'disk-titled' },
    },
    {
      structured: { kind: 'disk' },
      blobs: { kind: 'azure' },
      files: { kind: 'disk-titled' },
    },
  ] as const)('requires an awaited init for %j', (profile) => {
    expect(requiresExplicitInit(profile)).toBe(true);
  });
});
