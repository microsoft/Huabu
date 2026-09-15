// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which product features a storage profile can actually serve.
 *
 * Some features are *about* a filesystem — showing a folder in Finder,
 * adopting a document a user dropped in from outside, a bundle that is a
 * directory zipped up. A backend that keeps Spaces in tables has no honest
 * answer for them, and the honest outcome is that the feature is
 * **unavailable, not emulated** (proposal §6.4.2, disposition A). A
 * workaround that makes such a feature *nearly* work is worse than its
 * absence: it has to be built, tested, and explained, and it hides the
 * limitation instead of stating it.
 *
 * "Stated" is what this file is for. An outcome of A is an acceptable product
 * limitation only if an operator can learn it when they select a profile
 * rather than when a user clicks the button — so the matrix sits beside
 * profile validation, which is the one place a profile is inspected before
 * anything opens.
 *
 * This is a *declaration*, not an enforcement point. Each listed feature also
 * refuses at its own call site, because a matrix nobody consults at runtime is
 * documentation. What the matrix adds is the up-front answer.
 *
 * Two rules keep those call sites honest:
 *
 *   - **A refusal asks the matrix.** `storageServes(id)` on the composition
 *     root, never a re-derivation of the requirement such as "is there a
 *     `diskTree`". A gate that re-derives is a second copy of the rule, and it
 *     is how a row could grow a blob-axis requirement its own call site never
 *     learned about.
 *   - **A degradation does not.** Code that renders absence rather than
 *     refusing — the memory preamble reading as empty — asks the concrete
 *     predicate, because it is not making the profile's promise, only reading
 *     what is there.
 *
 * Every row must therefore be refusable. A property that nothing can ask about
 * is not a capability: it is a fact about a backend, and it belongs in that
 * backend's own commentary. Windows directory-handle coordination was listed
 * here and removed for exactly that reason — a Space with no directory
 * registers no handle owner, so nothing ever asks and nothing is lost.
 */

import type { BlobBackendKind } from './ports/blob.js';
import type { StructuredBackendKind } from './ports/structured.js';
import type { StorageProfile } from './profile.js';

/**
 * A product feature some storage profiles cannot serve.
 *
 * Keyed on the **profile**, not on one axis. Most entries need a Space or a
 * Workspace to be a real directory, which is a structured-backend property —
 * but several need more than that: they need the Space's *bytes* to be in that
 * directory too, and that is the blob backend's business. A matrix that asked
 * only the structured axis would call a bundle exportable on a profile that
 * archives a Space folder its artifacts had never been written to.
 *
 * Each row therefore states a {@link StorageRequirement} rather than a list of
 * backends: every axis it names must hold, and an axis it does not name is one
 * it does not depend on.
 */
export interface StorageCapability {
  /** Stable id, for a diagnostic an operator can search for. */
  readonly id: string;
  /** What a user loses, in their vocabulary rather than the port's. */
  readonly summary: string;
  /** What a deployment must be for this feature to work. */
  readonly requires: StorageRequirement;
  /** Why it cannot be served elsewhere, and what remains instead. */
  readonly rationale: string;
}

/**
 * The condition a profile has to meet, one clause per storage axis.
 *
 * **Every clause present must hold** — the axes are an `and`, because a
 * feature that needs both a Space directory and the Space's bytes inside it
 * needs both, not either. **Within a clause the backends are an `or`**: the
 * configured backend has to be one of them.
 *
 * So `{ structured: ['disk'], blobs: ['disk'] }` reads "the structured backend
 * must be Disk *and* the blob backend must be Disk", and a future
 * `{ structured: ['disk', 'postgres'] }` would read "the structured backend
 * must be Disk *or* Postgres, and the blob backend may be anything".
 *
 * **An absent clause is not a requirement**, so every backend on that axis
 * passes. That default is the design rather than a shortcut: a feature that
 * does not touch a Space's bytes must not need editing when a blob backend is
 * added, and the features that do are exactly the ones that should be forced
 * to decide then. A requirement with no clauses at all requires nothing, which
 * is not a limitation — `capabilities.test.ts` rejects one.
 */
export interface StorageRequirement {
  /** Structured backends that satisfy it; absent means any does. */
  readonly structured?: readonly StructuredBackendKind[];
  /** Blob backends that satisfy it; absent means any does. */
  readonly blobs?: readonly BlobBackendKind[];
}

export const STORAGE_CAPABILITIES: readonly StorageCapability[] = [
  {
    id: 'space-bundle-export',
    summary: 'Export a Space as a .huabu.zip bundle',
    requires: { structured: ['disk'], blobs: ['disk'] },
    rationale:
      'The bundle is a Disk projection — the Space directory, archived — so ' +
      'it needs both halves of that directory: the records and the bytes. A ' +
      'portable export generated from records plus reachable blob references ' +
      'is a separate design.',
  },
  {
    id: 'space-bundle-import',
    summary: 'Import a Space from a .huabu.zip bundle',
    requires: { structured: ['disk'], blobs: ['disk'] },
    rationale:
      'Pairs with export; unzips into place, which is only the whole Space ' +
      'where the whole Space is in that place.',
  },
  {
    id: 'reveal-space-folder',
    summary: "Open a Space's nodes folder in the OS file manager",
    requires: { structured: ['disk'] },
    rationale:
      'It opens the folder of node documents so a user can settle a ' +
      'duplicate-markdown collision by hand. Off Disk a node is a row: there ' +
      'is no folder of documents to open, and the collision it exists to ' +
      'settle cannot arise, because label uniqueness is a constraint rather ' +
      "than a filename. The Space's byte areas are files, but they are " +
      'hidden, Server-owned, and hold artifacts rather than documents — ' +
      'opening those would answer a question nobody asked. No blob clause: ' +
      'the folder is still the documents wherever the bytes went.',
  },
  {
    id: 'builtin-file-tools',
    summary: 'Built-in agent file tools (read, write, glob, grep)',
    requires: { structured: ['disk'], blobs: ['disk'] },
    rationale:
      'They sandbox on the Space directory and the documents they exist to ' +
      'edit are the node sidecars under `nodes/`, which are rows here. A ' +
      "Space's byte areas are files on every profile, but they hold " +
      'artifacts and uploads, not the documents an agent reads and writes. ' +
      'Off Disk the first-party agent goes through the Canvas tools instead, ' +
      'which is the portable surface it already prefers for structured edits.',
  },
  {
    id: 'space-file-plane',
    summary: 'Reach a Space as files over RFS, the plane external agents mount',
    requires: { structured: ['disk'], blobs: ['disk'] },
    rationale:
      'RFS projects the Space directory over HTTP — the record and the node ' +
      'sidecars, reachable from another machine. Those are rows here, and a ' +
      'projection of the byte areas alone would be a different plane wearing ' +
      "this one's name. It is listed apart from the built-in file tools " +
      'because it is what those tools were said to fall back to: a Space ' +
      'with no file plane has neither, and an external agent bound to a ' +
      'Space on this backend reaches it through the Canvas API.',
  },
  {
    id: 'external-note-discovery',
    summary: 'Adopt Markdown files dropped into a Space from outside the app',
    requires: { structured: ['disk'] },
    rationale:
      'It watches `nodes/` for documents that arrived without going through ' +
      'the application. That tier is rows here, and no byte area is a place ' +
      'a user would drop a note into: they are hidden, Server-owned, and ' +
      'hold artifacts. Inventing an arrival path would buy nothing.',
  },
  {
    id: 'workspace-directory',
    summary: 'Choose, create, or reveal a Workspace folder on this machine',
    requires: { structured: ['disk'] },
    rationale:
      'A Workspace is a folder the user picks. Where Workspaces are rows ' +
      'there is nothing to browse to: the Server opens its own on first ' +
      'start and Workspaces are created and managed by name instead of by ' +
      'path. The per-Workspace directory under the blob root is Server-owned ' +
      'storage for bytes, not a Workspace a user could choose or move.',
  },
  {
    id: 'workspace-user-memory',
    summary: 'The cross-Space user memory document (setting/user.md)',
    requires: { structured: ['disk'] },
    rationale:
      'A user-editable file at the Workspace root, deliberately outside any ' +
      'Space so it applies to all of them. The blob port has no ' +
      'Workspace-level scope — every area it vends belongs to a Space — so ' +
      'the document has no scope to live in, whatever directories happen to ' +
      "exist. A Space's own memory body is unaffected; it is a blob.",
  },
  {
    id: 'workspace-user-skills',
    summary: 'User-authored skills under the Workspace setting/skills folder',
    requires: { structured: ['disk'] },
    rationale:
      'Skills are read as files a user can edit and drop in by hand, which ' +
      'is the same arrival path external notes rely on. Bundled and Agent ' +
      'Team skills are unaffected.',
  },
];

/**
 * Whether one profile serves one capability.
 *
 * An axis the capability does not name is an axis it does not depend on, so
 * every backend there passes. A profile may request a backend that has no
 * adapter — `validateStorageProfile` is what rejects those — and such a kind
 * appears in no list, which is the right answer: an unwritten backend serves
 * nothing.
 */
function serves(
  capability: StorageCapability,
  profile: StorageProfile,
): boolean {
  /** One clause: absent requires nothing, present is met by any member. */
  const satisfied = (
    allowed: readonly string[] | undefined,
    configured: string,
  ): boolean => allowed === undefined || allowed.includes(configured);

  const { structured, blobs } = capability.requires;
  // Every clause, not any: a feature needing a Space directory *and* the
  // Space's bytes inside it is not served by half of that.
  return (
    satisfied(structured, profile.structured.kind) &&
    satisfied(blobs, profile.blobs.kind)
  );
}

/** Capabilities this profile cannot serve. */
export function unavailableCapabilities(
  profile: StorageProfile,
): readonly StorageCapability[] {
  return STORAGE_CAPABILITIES.filter(
    (capability) => !serves(capability, profile),
  );
}

/**
 * Whether this profile serves `id`. Unknown ids are available by omission.
 *
 * Application code should not reach this directly — the only profile worth
 * asking about is the one storage was opened with, and the composition root's
 * `storageServes(id)` is bound to it. This form exists for the matrix's own
 * tests, which need to ask about profiles the process is not running.
 */
export function hasStorageCapability(
  profile: StorageProfile,
  id: string,
): boolean {
  const capability = STORAGE_CAPABILITIES.find((entry) => entry.id === id);
  return capability === undefined || serves(capability, profile);
}

/**
 * The refusal a Disk-only feature raises when it finds no Space directory.
 *
 * Shares its wording with the startup declaration, so the sentence an
 * operator read when they chose the profile is the sentence they see in the
 * failure. A feature that phrased its own refusal would drift from the
 * matrix, and the drift would only show up in a support thread.
 */
export function unavailableCapabilityMessage(id: string): string {
  const capability = STORAGE_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) {
    return `Storage capability "${id}" is not available on this backend.`;
  }
  return (
    `${capability.summary} is not available on this storage backend ` +
    `(capability "${capability.id}"). ${capability.rationale}`
  );
}

/**
 * One operator-facing line per feature this profile does not offer.
 *
 * Rendered at startup rather than raised: an unavailable feature is a stated
 * limitation, not a misconfiguration, so it must not stop the Server. The
 * distinction matters — a profile naming an unimplemented backend *is* a
 * misconfiguration and still fails fast in `validateStorageProfile`.
 */
export function describeUnavailableCapabilities(
  profile: StorageProfile,
): readonly string[] {
  const label = `${profile.structured.kind}/${profile.blobs.kind}`;
  return unavailableCapabilities(profile).map(
    (capability) =>
      `${capability.id}: ${capability.summary} — unavailable on the ` +
      `"${label}" storage profile. ${capability.rationale}`,
  );
}
