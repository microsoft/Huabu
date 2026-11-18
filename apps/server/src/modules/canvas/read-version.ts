// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read-version check for an executor batch — the Server's side of it.
 *
 * A caller that quotes the version it read (an edit's `basis`) is asking: "apply this only if the nodes it names are still the
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

import {
  parseBasis,
  type Basis,
  type CanvasExecuteEditRef,
} from '@huabu/shared';

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

/** One edit of a request, decoded. */
export interface ResolvedEdit {
  /** The Space version the edit was made on, when it quoted one. */
  readonly version?: number;
  /** Earlier edits of this request it was made on top of, by position. */
  readonly after: number[];
  /**
   * It was made on top of an edit of an earlier request that did not take
   * effect, or whose outcome is not stored.
   */
  readonly blocked: boolean;
}

/**
 * Decode the edits of a request: each `basis` against the Space's stamps,
 * each `after` into positions of this request or a lookup of an earlier one.
 *
 * Returns the basis that is not a read version of this Space, when there is
 * one. An edit made on top of an edit of an *earlier* request is looked up
 * in that request's stored outcome (`lookup`, by the caller's own key
 * space): it is `blocked` unless that outcome is stored and says the named
 * edit took effect.
 *
 * @param input.stamps required when an edit quotes a `basis`.
 */
export async function resolveEdits(input: {
  readonly edits: readonly {
    readonly basis?: string | undefined;
    readonly after?: readonly CanvasExecuteEditRef[] | undefined;
  }[];
  readonly stamps: SpaceStamps | null;
  readonly principalId: string | undefined;
  readonly lookup: (key: SaveKey) => Promise<StoredSaveResult | null>;
}): Promise<
  { ok: true; edits: ResolvedEdit[] } | { ok: false; basis: string }
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

  const edits: ResolvedEdit[] = [];
  for (const [index, edit] of input.edits.entries()) {
    let version: number | undefined;
    if (edit.basis !== undefined) {
      const read = input.stamps
        ? resolveReadVersion(edit.basis, input.stamps)
        : null;
      if (!read) return { ok: false, basis: edit.basis };
      version = read.version;
    }
    let blocked = false;
    const after: number[] = [];
    for (const ref of edit.after ?? []) {
      if (ref.operationId === undefined) {
        // Only an earlier edit of the request can have been built on.
        if (ref.edit < index) after.push(ref.edit);
        else blocked = true;
        continue;
      }
      const stored = await storedOf(ref.operationId);
      if (!storedEditApplied(stored?.response, ref.edit)) blocked = true;
    }
    edits.push({
      ...(version !== undefined ? { version } : {}),
      after,
      blocked,
    });
  }
  return { ok: true, edits };
}

/** Whether a stored outcome says its edit at `index` took effect. */
function storedEditApplied(response: unknown, index: number): boolean {
  const edits = (response as { edits?: unknown } | null | undefined)?.edits;
  if (!Array.isArray(edits)) return false;
  const edit = edits[index] as { applied?: unknown } | undefined;
  return edit?.applied === true;
}
