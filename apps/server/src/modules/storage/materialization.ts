// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Where a Space's tree lives on a real filesystem.
 *
 * **Not a port, and deliberately not in `ports/`.** The settled architecture
 * is two backend ports — `StructuredStore` for domain records, `BlobStore`
 * for opaque bytes — and this is neither. A port abstracts a *backend
 * family*: swap the adapter and the same contract is served by SQLite, or
 * Postgres, or Azure. Materialization has no families to abstract. It is
 * always the local filesystem, under every profile, because its whole purpose
 * is to hand a real path to something that cannot take a record: an ACP
 * agent's working directory, a watcher's target, the tree RFS exposes.
 *
 * What varies is not the substrate but the **placement policy** — given a
 * Space id, which directory. That is a composition-root decision, which is
 * why this lives beside `storage.ts` and `profile.ts` rather than beside the
 * ports. §12.5.4 named it correctly at the time: "an explicit capability a
 * consumer depends on by name and a profile can decline to offer", the
 * Space-level counterpart to `BlobScope.materialize()` — one level *down*
 * from the port layer, not a third peer of it.
 *
 * The tell that it was never an axis: the policy cannot be configured. It is
 * derived from the structured backend and validated, because a backend that
 * stores each Space as a directory has already decided where that Space is.
 * A knob with exactly one correct value per deployment is not a knob.
 */

import type { StorageHealth } from './ports/common.js';
import type { RequestedStructuredKind } from './profile.js';
import type { CanvasFile } from '../canvas/persistence-types.js';

/**
 * How a placement policy decides which directory a Space gets.
 *
 * Not a backend kind — neither name is a storage vendor, because both are the
 * same substrate. `titled` files a Space under its title and moves that
 * directory on rename: the Finder-visible Workspace Huabu ships, which can
 * only resolve a locator by consulting title-bearing structured records.
 * `addressed` files it under its stable id and consults nothing, which is
 * what a structured backend keeping Spaces in tables needs.
 */
export type MaterializationKind = 'titled' | 'addressed';

/**
 * The policy a structured backend forces.
 *
 * `disk` stores each Space as `<workspace>/<safe(title)>/space.json` with its
 * nodes beside it, so it has already chosen the directory and the
 * materialization must name that same one. Give it `addressed` instead and a
 * Space's blobs land in `<workspace>/<canvasId>/` while its records stay
 * under the title — two directories for one Space, neither looking wrong.
 *
 * A structured backend that keeps Spaces in tables has chosen no directory,
 * so nothing has to be agreed with and the stable id is the better address.
 */
export function materializationFor(
  structured: RequestedStructuredKind,
): MaterializationKind {
  return structured === 'disk' ? 'titled' : 'addressed';
}

export interface SpaceTreeHandleOwner {
  release(): Promise<void> | void;
  reacquire(): Promise<void> | void;
}

/** One Space's materialized tree. */
export interface SpaceTree {
  readonly canvasId: string;
  /** Absolute root of this Space's materialized filesystem view. */
  directory(): string;
  /** Absolute path to the materialized node-record directory. */
  nodesDirectory(): string;
  /**
   * The node record a materialized file carries, or null when none does.
   *
   * Which file stands for which record is the policy's own business — a
   * titled layout answers it from the sidecar index, an addressed one from
   * the name. A consumer that derived it from file *content* would be reading
   * the structured backend's record encoding, which is what this capability
   * exists to keep out of feature modules. `relativePath` is Space-relative
   * and uses `/` separators.
   */
  nodeIdForPath(relativePath: string): Promise<string | null>;
  /** Register a live native handle that must be released for rename/delete. */
  registerHandleOwner(owner: SpaceTreeHandleOwner): () => void;
}

export interface SpaceImportStaging {
  readonly canvasId: string;
  readonly directory: string;
  /**
   * Adopt the staged directory as this Space's materialization.
   *
   * Returns the record as materialized. A titled policy may hand back an
   * adjusted title, because the directory it allocates is derived from that
   * title and the name may already be taken; an addressed one returns the
   * record unchanged. Callers must use the returned record, not the one they
   * passed in.
   */
  publish(record: CanvasFile): Promise<CanvasFile>;
  /** Remove the unpublished staging directory. Idempotent after publish. */
  discard(): Promise<void>;
}

/** The Workspace-bound materialization the composition root selected. */
export interface SpaceMaterialization {
  readonly kind: MaterializationKind;
  init(): Promise<void>;
  /**
   * Refresh process-local locators after a Workspace commit.
   *
   * Called once, after the new Workspace path is committed and before the
   * mount is swapped in. It must perform no fallible work: everything that
   * can fail belongs in `init()`, which runs while the mount is still staged
   * and can still be abandoned.
   */
  activate(): void;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceTree;
  /** Allocate an isolated directory for one uploaded Space bundle. */
  stageImport(canvasId: string): Promise<SpaceImportStaging>;
}
