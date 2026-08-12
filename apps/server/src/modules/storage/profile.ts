// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage backend selection.
 *
 * Structured and blob storage are independent configuration axes — the
 * settled direction of docs/proposals/multi-backend-storage.md §6.3. A
 * profile names one backend on each axis; not every pairing is a valid
 * deployment, so profiles are validated before any connection is opened.
 */

import type { BlobBackendKind } from './ports/blob.js';

/**
 * Structured backend families a profile may name.
 *
 * Wider than the port's `StructuredBackendKind`, which names only what an
 * adapter exists for. Keeping the two apart is what lets a
 * configured-but-unwritten backend fail with "not implemented yet" instead of
 * "not a known backend", without the port advertising adapters that do not
 * exist.
 */
export type RequestedStructuredKind = 'disk' | 'sqlite' | 'postgres';

export interface StorageProfile {
  structured: { kind: RequestedStructuredKind };
  blobs: { kind: BlobBackendKind };
}

/**
 * Backends that exist today. Naming one that is not written yet must fail
 * loudly rather than half-work.
 */
const IMPLEMENTED_STRUCTURED: readonly RequestedStructuredKind[] = ['disk'];
const IMPLEMENTED_BLOBS: readonly BlobBackendKind[] = ['disk'];

const STRUCTURED_KINDS: readonly RequestedStructuredKind[] = [
  'disk',
  'sqlite',
  'postgres',
];
const BLOB_KINDS: readonly string[] = ['disk', 'azure'];

export class StorageProfileError extends Error {
  override name = 'StorageProfileError';
}

function readKind(
  envKey: string,
  raw: string | undefined,
  known: readonly string[],
): string {
  const value = (raw ?? 'disk').trim().toLowerCase();
  if (!known.includes(value)) {
    throw new StorageProfileError(
      `${envKey}="${value}" is not a known backend. Expected one of: ${known.join(', ')}.`,
    );
  }
  return value;
}

/** Build a profile from the environment. Both axes default to `disk`. */
export function parseStorageProfile(
  env: NodeJS.ProcessEnv = process.env,
): StorageProfile {
  return {
    structured: {
      kind: readKind(
        'HUABU_STRUCTURED_BACKEND',
        env['HUABU_STRUCTURED_BACKEND'],
        STRUCTURED_KINDS,
      ) as RequestedStructuredKind,
    },
    blobs: {
      kind: readKind(
        'HUABU_BLOB_BACKEND',
        env['HUABU_BLOB_BACKEND'],
        BLOB_KINDS,
      ) as BlobBackendKind,
    },
  };
}

/**
 * Reject profiles that cannot serve correctly, before any connection opens.
 *
 * Today that means "named but not implemented". This is also where
 * cross-axis rules belong as backends land — for example, Postgres paired
 * with a node-local disk blob root is unsafe across replicas unless the
 * path is a deliberately shared filesystem.
 */
export function validateStorageProfile(profile: StorageProfile): void {
  if (!IMPLEMENTED_STRUCTURED.includes(profile.structured.kind)) {
    throw new StorageProfileError(
      `Structured backend "${profile.structured.kind}" is not implemented yet. ` +
        `Available: ${IMPLEMENTED_STRUCTURED.join(', ')}.`,
    );
  }
  if (!IMPLEMENTED_BLOBS.includes(profile.blobs.kind)) {
    throw new StorageProfileError(
      `Blob backend "${profile.blobs.kind}" is not implemented yet. ` +
        `Available: ${IMPLEMENTED_BLOBS.join(', ')}.`,
    );
  }
}

/**
 * Backends whose `init()` has nothing to open, so building them on demand is
 * safe.
 *
 * The lazy accessor in `storage.ts` is synchronous and therefore cannot
 * `await init()`. That is harmless for backends which have no connection to
 * establish, and silently wrong for any that do — they would be handed to
 * callers unopened. Keeping the list here, next to the other backend facts,
 * means adding an adapter forces a decision about it.
 */
const LAZY_SAFE_STRUCTURED: readonly RequestedStructuredKind[] = ['disk'];
const LAZY_SAFE_BLOBS: readonly BlobBackendKind[] = ['disk'];

/** Whether this profile may only be built through an awaited `initStorage()`. */
export function requiresExplicitInit(profile: StorageProfile): boolean {
  return (
    !LAZY_SAFE_STRUCTURED.includes(profile.structured.kind) ||
    !LAZY_SAFE_BLOBS.includes(profile.blobs.kind)
  );
}
