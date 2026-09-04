// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the extension substrate.
 *
 * One reserved directory per namespace, under a hidden `.ext/` tier inside the
 * Space — the same tier as `.artifacts/` and `.history/`, because an
 * extension's store is machine state rather than something a user authors.
 *
 * Destruction is free here, and that is worth stating rather than relying on:
 * the namespace lives *inside* the Space directory, so the existing
 * `store.destroy()` removes it with everything else. A backend that keys
 * extensions by table prefix or schema has no such placement and must drop
 * them explicitly — which is why the contract asserts the outcome instead of
 * trusting the mechanism.
 */

import path from 'node:path';

import { canvasRoot } from './layout.js';
import { readDiskSpaceRecord } from './space-record.js';
import { mkdirp } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';
import { assertValidNamespace } from '../../ports/namespace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { SpaceHandle, SpaceSubstrate } from '../../ports/structured.js';

/** Hidden tier holding one directory per extension namespace. */
export const EXTENSIONS_DIR_NAME = '.ext';

export function createDiskSpaceExtension(
  store: CanvasStore,
): SpaceHandle['extension'] {
  const workspacePath = path.resolve(getWorkspacePath());

  function assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== workspacePath) {
      throw new Error(
        `Space extension(${store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  return async function extension(
    namespace: string,
  ): Promise<SpaceSubstrate | null> {
    assertValidNamespace(namespace);
    assertActiveWorkspace();
    // The existence check is the point, not a courtesy. Owners write through
    // ordinary filesystem calls, so handing back a path for a Space that was
    // just deleted would let the first write recreate its directory as a stub
    // holding nothing but bookkeeping. Every owner used to carry its own guard
    // against that; this is the one place that can state it.
    // Keep the check and path resolution in one synchronous turn. Awaiting the
    // asynchronous port-shaped `read()` here lets a Workspace switch occur
    // between validating A and resolving `canvasRoot()` against B.
    if (readDiskSpaceRecord(store) === null) return null;

    const directory = path.join(
      canvasRoot(store.canvasId),
      EXTENSIONS_DIR_NAME,
      namespace,
    );
    // Created on demand, so an owner receives somewhere it can write rather
    // than a path it has to prepare. The window between the check above and
    // an owner's own write stays open — a Space deleted inside it is the same
    // race the per-owner guards had — but nothing widens it.
    mkdirp(directory);
    return { kind: 'disk', directory };
  };
}
