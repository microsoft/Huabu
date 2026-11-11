// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read-version check for an executor batch.
 *
 * A caller that quotes the version it read (`basis`) is asking: "apply each
 * command only if the nodes it names are still the ones I saw". The answer is
 * given per command, from the Space's per-node version stamps — never by
 * comparing the basis with the head version, so unrelated writes by others do
 * not get in the way.
 *
 * Which nodes a command names is decided by `commandReadTargets` in the
 * shared engine; this file only compares them with the stamps.
 */

import { parseBasis, type Basis, type CanvasCommand } from '@huabu/shared';
import {
  commandReadTargets,
  type CanvasNode,
  type ExecutorOptions,
} from '@huabu/shared/canvas-engine';

import type { SpaceStamps } from '../storage/ports/save.js';

/**
 * Decode a basis and check that it names a version of this Space's history.
 *
 * `null` means it does not: malformed, issued under another lineage, newer
 * than the head, or older than the point the stamps start at.
 */
export function resolveReadVersion(
  basis: string,
  stamps: SpaceStamps,
): Basis | null {
  const parsed = parseBasis(basis);
  if (!parsed) return null;
  if (parsed.lineage !== stamps.lineage.toLowerCase()) return null;
  if (parsed.version > stamps.version || parsed.version < stamps.floor) {
    return null;
  }
  return parsed;
}

/**
 * Build the engine's `admit` hook for one batch.
 *
 * - A target that is missing from the state the command would run against,
 *   or that was created after the basis version, rejects the command with
 *   `stale-target`.
 * - A membership target whose parent changed after the basis version rejects
 *   it with `stale-parent`.
 * - A node this batch itself brought into existence — an id absent from the
 *   prestate, or one an earlier command of the batch removed and a later one
 *   created again — is never stale: its author is the caller.
 *
 * Stamps describe the prestate, so what earlier commands of the same batch
 * did to a node never counts against a later one.
 *
 * @param exempt commands the Server added to the batch itself; they follow
 *   from an authored command and are not checked on their own.
 */
export function createReadVersionAdmit(input: {
  readonly basis: Basis;
  readonly stamps: SpaceStamps;
  readonly prestateNodes: readonly CanvasNode[];
  readonly exempt?: ReadonlySet<CanvasCommand>;
}): NonNullable<ExecutorOptions['admit']> {
  const { basis, stamps, exempt } = input;
  const prestateIds = new Set(input.prestateNodes.map((node) => node.id));
  /** Prestate ids seen absent at some point of the batch. */
  const removedInBatch = new Set<string>();

  return (command, state) => {
    const present = new Set<string>(state.nodes.map((node) => node.id));
    for (const id of prestateIds) {
      if (!present.has(id)) removedInBatch.add(id);
    }
    if (exempt?.has(command)) return undefined;

    const targets = commandReadTargets(command);
    if (targets.existence.length === 0) return undefined;

    const madeByBatch = (id: string): boolean =>
      !prestateIds.has(id) || removedInBatch.has(id);

    for (const id of targets.existence) {
      if (!present.has(id)) return 'stale-target';
      if (madeByBatch(id)) continue;
      const created = stamps.nodes[id]?.created ?? stamps.floor;
      if (created > basis.version) return 'stale-target';
    }
    for (const id of targets.membership) {
      if (madeByBatch(id)) continue;
      const membership = stamps.nodes[id]?.membership ?? stamps.floor;
      if (membership > basis.version) return 'stale-parent';
    }
    return undefined;
  };
}
