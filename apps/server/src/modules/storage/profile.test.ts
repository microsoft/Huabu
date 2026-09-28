// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
} from './profile.js';

import type {
  RequestedBlobKind,
  RequestedStructuredKind,
  StorageProfile,
} from './profile.js';

/**
 * Every pairing a deployment may select today.
 *
 * Spelled out rather than derived from the module's own lists: derivation
 * would restate the implementation and agree with it however it changed,
 * and the claim worth keeping is that *these six* deployments are supported.
 */
const IMPLEMENTED_PAIRINGS: readonly StorageProfile[] = (
  ['disk', 'sqlite', 'postgres'] as const
).flatMap((structured) =>
  (['disk', 'azure'] as const).map((blobs) => ({
    structured: { kind: structured },
    blobs: { kind: blobs },
  })),
);

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

  it('accepts Postgres records beside disk blobs', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'postgres' },
        blobs: { kind: 'disk' },
      }),
    ).not.toThrow();
  });

  // Fewer features is a stated limitation, not a misconfiguration: a profile
  // may lose capabilities as long as the matrix declares them. Only an
  // unimplemented backend fails here — the axes share nothing, so every
  // pairing of implemented backends is a valid deployment.
  it('accepts sqlite records beside disk blobs', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'sqlite' },
        blobs: { kind: 'disk' },
      }),
    ).not.toThrow();
  });

  it('accepts Azure blobs with Disk records', () => {
    expect(() =>
      validateStorageProfile({
        structured: { kind: 'disk' },
        blobs: { kind: 'azure' },
      }),
    ).not.toThrow();
  });

  // The axes share nothing, so selecting an adapter on one must never
  // disqualify an adapter on the other. Six pairings is the whole deployment
  // matrix, and a pairing rejected here would be a deployment refused at boot
  // for no reason a rationale could be written for.
  it.each(IMPLEMENTED_PAIRINGS)('accepts the %j deployment', (profile) => {
    expect(() => validateStorageProfile(profile)).not.toThrow();
  });

  // A kind can be a known member of the target family while having no adapter.
  // That must fail at startup with a sentence, not on the first upload with a
  // stack trace — the whole reason the requested vocabulary is kept apart from
  // the available one. Nothing in the environment can reach this today, since
  // every named kind now has an adapter, so it is asserted where the next
  // unwritten backend will first appear: a profile handed in by a caller.
  it.each([
    {
      profile: {
        structured: { kind: 'mysql' as RequestedStructuredKind },
        blobs: { kind: 'disk' as const },
      },
      pattern:
        /Structured backend "mysql" is not implemented yet.*disk, sqlite, postgres/s,
    },
    {
      profile: {
        structured: { kind: 'disk' as const },
        blobs: { kind: 's3' as RequestedBlobKind },
      },
      pattern: /Blob backend "s3" is not implemented yet.*disk, azure/s,
    },
  ])('refuses an unimplemented $profile at startup', ({ profile, pattern }) => {
    expect(() => validateStorageProfile(profile)).toThrow(StorageProfileError);
    expect(() => validateStorageProfile(profile)).toThrow(pattern);
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

  // Every pairing but Disk/Disk, so the answer is a property of the matrix
  // rather than of the three cases someone happened to write down. Both axes
  // can disqualify the lazy path independently: Azure has a container to
  // validate before it may vend a scope, which is an `await` the synchronous
  // accessor has no way to perform, so a Disk structured backend does not
  // rescue it.
  it.each(
    IMPLEMENTED_PAIRINGS.filter(
      (profile) =>
        profile.structured.kind !== 'disk' || profile.blobs.kind !== 'disk',
    ),
  )('requires an awaited init for %j', (profile) => {
    expect(requiresExplicitInit(profile)).toBe(true);
  });

  it('is decided by the blob axis on its own', () => {
    // The one pair that isolates it: the structured backend is the same
    // lazy-safe Disk on both sides, so only the bytes moved.
    expect(
      requiresExplicitInit({
        structured: { kind: 'disk' },
        blobs: { kind: 'disk' },
      }),
    ).toBe(false);
    expect(
      requiresExplicitInit({
        structured: { kind: 'disk' },
        blobs: { kind: 'azure' },
      }),
    ).toBe(true);
  });
});
