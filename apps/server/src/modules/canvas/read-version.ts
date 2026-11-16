// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read-version check for an executor batch — the Server's side of it.
 *
 * A caller that quotes the version it read (`basis`, or one per edit in
 * `runs`) is asking: "apply this only if the nodes it names are still the
 * ones I saw". The answer comes from the Space's per-node version stamps —
 * never by comparing the basis with the head version, so unrelated writes by
 * others do not get in the way.
 *
 * Which nodes a command names (`commandReadTargets`) and how they are
 * compared with the stamps (`createReadVersionAdmission`) are decided in the
 * shared engine. This file decodes what the caller sent against the Space's
 * stamps: the basis strings, the page the request comes from, and the
 * earlier requests an edit says it was made on top of.
 */

import { createHash } from 'node:crypto';

import { parseBasis, type Basis, type CanvasExecuteRun } from '@huabu/shared';
import {
  isRefusedResult,
  type ReadVersionRun,
} from '@huabu/shared/canvas-engine';

import type {
  SaveKey,
  SpaceStamps,
  StoredSaveResult,
} from '../storage/ports/save.js';

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
 * The key node stamps name a browser page by: the authenticated principal
 * together with the page's own id (`originator.tabId`).
 *
 * Both parts count. The same person's other device or tab is another page,
 * and its changes are foreign to this one; a page id is chosen by the page,
 * so on its own it would let one caller pass for another. Hashed so a stamp
 * stays small and holds no principal id.
 */
export function pageKeyOf(principalId: string, pageId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([principalId, pageId]))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Decode the runs of a request against the Space's stamps.
 *
 * Returns the basis that is not a read version of this Space, when there is
 * one. An edit made on top of an edit of an *earlier* request is looked up
 * in that request's stored response (`lookup`, by the caller's own key
 * space): it is `blocked` unless that response is stored and none of the
 * named commands was refused.
 */
export async function resolveRuns(input: {
  readonly runs: readonly CanvasExecuteRun[];
  readonly stamps: SpaceStamps;
  readonly principalId: string | undefined;
  readonly lookup: (key: SaveKey) => Promise<StoredSaveResult | null>;
}): Promise<
  { ok: true; runs: ReadVersionRun[] } | { ok: false; basis: string }
> {
  const earlier = new Map<string, Promise<StoredSaveResult | null>>();
  const storedOf = (operationId: string): Promise<StoredSaveResult | null> => {
    const key = operationId.toLowerCase();
    let pending = earlier.get(key);
    if (!pending) {
      pending = input.principalId
        ? input.lookup({ principalId: input.principalId, operationId: key })
        : Promise.resolve(null);
      earlier.set(key, pending);
    }
    return pending;
  };

  const runs: ReadVersionRun[] = [];
  for (const run of input.runs) {
    const read = resolveReadVersion(run.basis, input.stamps);
    if (!read) return { ok: false, basis: run.basis };
    let blocked = false;
    const after: { start: number; count: number }[] = [];
    for (const ref of run.after ?? []) {
      if (ref.operationId === undefined) {
        after.push({ start: ref.start, count: ref.count });
        continue;
      }
      const stored = await storedOf(ref.operationId);
      const results = (
        stored?.response as { results?: unknown } | null | undefined
      )?.results;
      const named = Array.isArray(results)
        ? results.slice(ref.start, ref.start + ref.count)
        : [];
      if (
        named.length !== ref.count ||
        named.some(
          (result) =>
            result === null ||
            typeof result !== 'object' ||
            isRefusedResult(result as { applied: boolean; reason?: string }),
        )
      ) {
        blocked = true;
      }
    }
    runs.push({
      start: run.start,
      count: run.count,
      version: read.version,
      ...(after.length > 0 ? { after } : {}),
      ...(blocked ? { blocked: true } : {}),
    });
  }
  return { ok: true, runs };
}
