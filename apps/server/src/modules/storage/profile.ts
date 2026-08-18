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
import type { SpaceFilesKind } from './ports/files.js';

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
  /**
   * How Spaces are materialized on the filesystem.
   *
   * Recorded on the profile but **derived**, never configured: it follows
   * from the structured backend rather than being an independent choice.
   * A structured backend that keeps each Space as a directory of files has
   * already decided where that Space lives, and the materialization has to
   * name the same place or blobs and records end up in different
   * directories. One that keeps Spaces in tables has decided nothing, so the
   * materialization is free to address by id.
   *
   * It is still a field, and still validated, because the composition root
   * has to switch on something and a hand-built profile — a test, a future
   * caller — must not be able to pair them wrongly in silence.
   */
  files: { kind: SpaceFilesKind };
}

/**
 * Backends that exist today. Naming one that is not written yet must fail
 * loudly rather than half-work.
 */
const IMPLEMENTED_STRUCTURED: readonly RequestedStructuredKind[] = ['disk'];
const IMPLEMENTED_BLOBS: readonly BlobBackendKind[] = ['disk'];
const IMPLEMENTED_FILES: readonly SpaceFilesKind[] = [
  'disk-titled',
  'disk-addressed',
];

const STRUCTURED_KINDS: readonly RequestedStructuredKind[] = [
  'disk',
  'sqlite',
  'postgres',
];
const BLOB_KINDS: readonly string[] = ['disk', 'azure'];

/**
 * The materialization a structured backend forces.
 *
 * `disk` stores each Space as `<workspace>/<safe(title)>/space.json` and its
 * nodes beside it, so it has already chosen the directory; the
 * materialization must name that same one, which only the title-addressed
 * layout does. Give it the id-addressed layout instead and a Space's blobs
 * land in `<workspace>/<canvasId>/` while its records stay under the title —
 * two directories for one Space, neither of them wrong-looking.
 *
 * A structured backend that keeps Spaces in tables has chosen no directory,
 * so nothing has to be agreed with and the stable id is the better address.
 */
export function materializationFor(
  structured: RequestedStructuredKind,
): SpaceFilesKind {
  return structured === 'disk' ? 'disk-titled' : 'disk-addressed';
}

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

/**
 * Build a profile from the environment.
 *
 * Both configurable axes default to `disk`. The materialization is derived
 * from the structured choice rather than read from the environment — there is
 * no correct value a deployment could supply that differs from the one its
 * structured backend forces, so offering the knob would only offer a way to
 * break the Workspace.
 */
export function parseStorageProfile(
  env: NodeJS.ProcessEnv = process.env,
): StorageProfile {
  const structured = readKind(
    'HUABU_STRUCTURED_BACKEND',
    env['HUABU_STRUCTURED_BACKEND'],
    STRUCTURED_KINDS,
  ) as RequestedStructuredKind;
  return {
    structured: { kind: structured },
    blobs: {
      kind: readKind(
        'HUABU_BLOB_BACKEND',
        env['HUABU_BLOB_BACKEND'],
        BLOB_KINDS,
      ) as BlobBackendKind,
    },
    files: { kind: materializationFor(structured) },
  };
}

/**
 * Reject profiles that cannot serve correctly, before any connection opens.
 *
 * Two rules live here. "Named but not implemented" keeps a configured-but-
 * unwritten backend from half-working. Cross-axis coherence keeps a
 * combination that would quietly misbehave from starting at all — a
 * title-addressed materialization over records that carry no per-directory
 * title resolves every Space to a fallback path rather than failing, which
 * is the kind of wrong that surfaces as missing user data much later. More
 * such rules belong here as backends land; Postgres paired with a node-local
 * disk blob root, for instance, is unsafe across replicas unless the path is
 * a deliberately shared filesystem.
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
  if (!IMPLEMENTED_FILES.includes(profile.files.kind)) {
    throw new StorageProfileError(
      `Space materialization "${profile.files.kind}" is not implemented yet. ` +
        `Available: ${IMPLEMENTED_FILES.join(', ')}.`,
    );
  }
  const required = materializationFor(profile.structured.kind);
  if (profile.files.kind !== required) {
    throw new StorageProfileError(
      `Structured backend "${profile.structured.kind}" requires the ` +
        `"${required}" Space materialization, not "${profile.files.kind}". ` +
        `The two have to name the same directory for a Space, or its blobs ` +
        `and its records end up in different ones. This is derived by ` +
        `parseStorageProfile(); a profile built by hand must match it.`,
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
