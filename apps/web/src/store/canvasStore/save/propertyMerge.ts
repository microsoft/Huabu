// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Three-way merge of a property edit that the server refused as stale.
 *
 * A node's properties are independent of each other: two pages that change
 * different keys of one node have not contradicted each other, although both
 * saves quote the same content revision and the second is refused. This
 * module decides whether the refused edit can be made again on top of what
 * the server holds now, and what it then is.
 *
 * - **Keys.** For every key the edit sets or removes, the server's value must
 *   still be the one the edit was made on, or already be what the edit wants.
 *   Otherwise both sides changed the same key and nothing is merged.
 * - **Display order.** `propertyDisplayKeys` is an ordered list, so "a
 *   different key" is defined by membership: an edit that only adds, removes
 *   or renames entries (the order of the entries it keeps is unchanged) is
 *   applied to the server's list — removed entries are taken out, a renamed
 *   entry takes the place of its old name, added entries are appended. An
 *   edit that reorders entries merges only when the server's list is still
 *   the one the edit was made on.
 *
 * Pure functions only.
 */

import deepEqual from 'fast-deep-equal';

import { orderedPropertyKeys } from '@huabu/shared/canvas-engine';

import type { NodeProperties, PutNodeContentRequest } from '@huabu/shared';

export type PropertyEdit = Pick<
  PutNodeContentRequest,
  'properties' | 'propertyDisplayKeys'
>;

/** A node's property bag and display order as one side holds them. */
export interface PropertySide {
  properties?: NodeProperties | undefined;
  propertyDisplayKeys?: readonly string[] | undefined;
}

/**
 * `edit`, made on `base`, as it has to be sent on top of `server` — or `null`
 * when the other save changed something the edit changes too.
 */
export function rebasePropertyEdit(
  edit: PropertyEdit,
  base: PropertySide,
  server: PropertySide,
): PropertyEdit | null {
  for (const [key, wanted] of Object.entries(edit.properties ?? {})) {
    const before = ownValue(base.properties, key);
    const now = ownValue(server.properties, key);
    if (deepEqual(before, now)) continue;
    if (wanted === null ? now === undefined : deepEqual(now, wanted)) continue;
    return null;
  }
  if (edit.propertyDisplayKeys === undefined) return edit;
  const order = rebaseDisplayKeys(
    edit.propertyDisplayKeys,
    orderedPropertyKeys(base.properties ?? {}, base.propertyDisplayKeys ?? []),
    orderedPropertyKeys(
      server.properties ?? {},
      server.propertyDisplayKeys ?? [],
    ),
  );
  return order ? { ...edit, propertyDisplayKeys: order } : null;
}

function ownValue(bag: NodeProperties | undefined, key: string): unknown {
  return bag && Object.hasOwn(bag, key) ? bag[key] : undefined;
}

function rebaseDisplayKeys(
  mine: readonly string[],
  base: readonly string[],
  server: readonly string[],
): string[] | null {
  if (deepEqual(base, server) || deepEqual(mine, server)) return [...mine];
  const baseSet = new Set(base);
  const mineSet = new Set(mine);
  const added = mine.filter((key) => !baseSet.has(key));
  const removed = new Set(base.filter((key) => !mineSet.has(key)));
  const kept = (list: readonly string[], dropped: (key: string) => boolean) =>
    list.filter((key) => !dropped(key));
  // A reorder of the entries the edit keeps cannot be told apart from the
  // other save's order key by key.
  if (
    !deepEqual(
      kept(mine, (key) => !baseSet.has(key)),
      kept(base, (key) => removed.has(key)),
    )
  )
    return null;
  // A rename puts the new name where the old one was.
  const renamedTo = new Map<string, string>();
  for (const [index, key] of base.entries()) {
    const replacement = mine[index];
    if (
      removed.has(key) &&
      replacement !== undefined &&
      added.includes(replacement) &&
      mine.length === base.length
    )
      renamedTo.set(key, replacement);
  }
  const result: string[] = [];
  for (const key of server) {
    const renamed = renamedTo.get(key);
    if (!removed.has(key)) result.push(key);
    else if (renamed !== undefined) result.push(renamed);
  }
  for (const key of added) if (!result.includes(key)) result.push(key);
  return [...new Set(result)];
}
