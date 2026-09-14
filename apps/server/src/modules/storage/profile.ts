// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage backend selection.
 *
 * Structured and blob storage are independent configuration axes — the
 * settled direction of docs/proposals/multi-backend-storage.md §6.3. A
 * profile names one backend on each axis and every pairing of implemented
 * backends is a valid deployment, because the axes share nothing: records go
 * to the structured backend, bytes go to a file system. `sqlite` records with
 * `disk` bytes is an ordinary profile, not a special case.
 */

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

/**
 * Blob backend families a profile may name.
 *
 * Wider than the port's {@link BlobBackendKind} for the same reason
 * {@link RequestedStructuredKind} is wider than the structured one.
 *
 * Every member is a file system. Bytes are files wherever they live — a local
 * directory today, an object store later — and never rows in the structured
 * database, so the two axes stay genuinely independent and a deployment may
 * pair SQL records with ordinary files.
 */
export type RequestedBlobKind = 'disk' | 'azure';

export interface StorageProfile {
  structured: { kind: RequestedStructuredKind };
  blobs: { kind: RequestedBlobKind };
}

/**
 * Backends with an adapter, and therefore selectable.
 *
 * Selectable is not "identical to Disk". A profile may offer fewer features,
 * as long as every one it does not offer is declared in `capabilities.ts` and
 * refused where a user would reach for it. What disqualifies a backend is an
 * *undeclared* gap — a feature that would fail with a stack trace rather than
 * a sentence.
 */
const AVAILABLE_STRUCTURED: readonly RequestedStructuredKind[] = [
  'disk',
  'sqlite',
];
const AVAILABLE_BLOBS: readonly RequestedBlobKind[] = ['disk'];

const STRUCTURED_KINDS: readonly RequestedStructuredKind[] = [
  'disk',
  'sqlite',
  'postgres',
];
const BLOB_KINDS: readonly RequestedBlobKind[] = ['disk', 'azure'];

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
      ) as RequestedBlobKind,
    },
  };
}

/**
 * Reject profiles that cannot serve correctly, before any connection opens.
 *
 * Today that means either "named but not implemented" or "implemented only as
 * an isolated preview". This is also where cross-axis rules belong as
 * backends land — for example, Postgres paired with a node-local disk blob
 * root is unsafe across replicas unless the path is a deliberately shared
 * filesystem.
 *
 * A profile that merely offers *fewer features* is not rejected here. Those
 * are stated limitations rather than misconfigurations, and they are declared
 * in `capabilities.ts` and reported at startup — see
 * {@link describeUnavailableCapabilities}. Conflating the two would either
 * refuse a legitimate deployment or let a real misconfiguration through as a
 * warning.
 */
export function validateStorageProfile(profile: StorageProfile): void {
  if (!AVAILABLE_STRUCTURED.includes(profile.structured.kind)) {
    throw new StorageProfileError(
      `Structured backend "${profile.structured.kind}" is not implemented yet. ` +
        `Adapters available: ${AVAILABLE_STRUCTURED.join(', ')}.`,
    );
  }
  if (!AVAILABLE_BLOBS.includes(profile.blobs.kind)) {
    throw new StorageProfileError(
      `Blob backend "${profile.blobs.kind}" is not implemented yet. ` +
        `Available: ${AVAILABLE_BLOBS.join(', ')}.`,
    );
  }
}

/**
 * Structured backends whose `init()` has nothing to open, so building them on
 * demand is safe.
 *
 * The lazy accessor in `storage.ts` is synchronous and therefore cannot
 * `await init()`. That is harmless for a backend which has no connection to
 * establish, and silently wrong for any that does — it would be handed to
 * callers unopened. Keeping the list here, next to the other backend facts,
 * means adding an adapter forces a decision about it.
 *
 * Only the structured axis appears: every blob backend is a file system, and
 * a file system has no connection to open.
 */
const LAZY_SAFE_STRUCTURED: readonly RequestedStructuredKind[] = ['disk'];

/** Whether this profile may only be built through an awaited `initStorage()`. */
export function requiresExplicitInit(profile: StorageProfile): boolean {
  return !LAZY_SAFE_STRUCTURED.includes(profile.structured.kind);
}
