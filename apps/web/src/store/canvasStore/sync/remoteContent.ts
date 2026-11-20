// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Node content that arrives by a fetch (another page's save, announced by
 * an `invalidate`) is applied by the same rule as an `update`: it is turned
 * into the row an update would carry — the node as this page holds it, and
 * that node with the fetched fields — and handed to the one function that
 * decides what a remote change may touch (`toFieldLevelDeltas`, through
 * `BrowserSync.prepareRemote` on a page). A unit this page holds keeps its
 * local value and the fetched one is reported as withheld.
 *
 * Pure functions only.
 */

import { parseKey, type WithheldUnit } from './inFlight';
import {
  BODY_CONTENT_KEYS,
  contentFieldOfUnit,
  NODE_CONTENT_KEYS,
  withContentPatch,
} from '../save/nodeContentFields';

import type { Delta } from '@huabu/shared/canvas-engine';

/** What became of fetched content fields. */
export interface RemoteContentApplied {
  /**
   * The fields now shown, by their new value (`undefined`: removed). A
   * custom-property change is the whole bag as the node holds it now.
   */
  applied: Record<string, unknown>;
  /** The content fields kept back because this page holds them. */
  withheld: ReadonlySet<string>;
}

export const NO_REMOTE_CONTENT: RemoteContentApplied = {
  applied: {},
  withheld: new Set(),
};

/** The row an update would carry for `patch` of `local`'s data. */
export function remoteContentRow(
  local: { id: string; data?: unknown },
  patch: Readonly<Record<string, unknown>>,
): Delta {
  return {
    type: 'REPLACE_NODE',
    prev: local,
    next: {
      ...local,
      data: withContentPatch(
        (local.data ?? {}) as Record<string, unknown>,
        patch,
      ),
    },
  } as unknown as Delta;
}

/**
 * What a remote change did to a node's data: the keys of `patch` (and every
 * content key) whose value differs between `before` and `after`, and the
 * content fields among `withheld`.
 */
export function remoteContentOutcome(
  before: { data?: unknown },
  after: { data?: unknown },
  patch: Readonly<Record<string, unknown>>,
  withheld: readonly WithheldUnit[],
): RemoteContentApplied {
  const a = (before.data ?? {}) as Record<string, unknown>;
  const b = (after.data ?? {}) as Record<string, unknown>;
  const applied: Record<string, unknown> = {};
  for (const key of new Set([...NODE_CONTENT_KEYS, ...Object.keys(patch)])) {
    if (a[key] !== b[key]) applied[key] = b[key];
  }
  return { applied, withheld: withheldContentFields(withheld) };
}

/** The content fields among withheld units (`properties` for any of its keys). */
export function withheldContentFields(
  withheld: readonly WithheldUnit[],
): Set<string> {
  const fields = new Set<string>();
  for (const unit of withheld) {
    const field = contentFieldOfUnit(unit.unit)?.field;
    if (field) fields.add(field);
  }
  return fields;
}

/** Whether a set of content fields names one the content revision covers. */
export function namesBody(fields: Iterable<string>): boolean {
  for (const field of fields) if (BODY_CONTENT_KEYS.has(field)) return true;
  return false;
}

/**
 * A hold predicate over in-flight keys from one over (node, unit) pairs, for
 * holders that think in nodes: unsaved content, a node being edited.
 */
export function heldByNodeUnit(
  holds: (nodeId: string, unit: string) => boolean,
): (key: string) => boolean {
  return (key) => {
    const parsed = parseKey(key);
    return parsed?.kind === 'node' && holds(parsed.nodeId, parsed.unit);
  };
}

/** The units kept back per node. */
export function withheldByNode(
  withheld: readonly WithheldUnit[],
): Map<string, Set<string>> {
  const byNode = new Map<string, Set<string>>();
  for (const unit of withheld) {
    const units = byNode.get(unit.nodeId) ?? new Set<string>();
    units.add(unit.unit);
    byNode.set(unit.nodeId, units);
  }
  return byNode;
}

/** `rows` without the insertion of the given nodes and of edges to them. */
export function withoutNodes(
  rows: readonly Delta[],
  nodeIds: ReadonlySet<string>,
): Delta[] {
  if (nodeIds.size === 0) return [...rows];
  return rows.filter(
    (row) =>
      !(row.type === 'INSERT_NODE' && nodeIds.has(row.node.id)) &&
      !(
        row.type === 'INSERT_EDGE' &&
        (nodeIds.has(row.edge.source) || nodeIds.has(row.edge.target))
      ),
  );
}

function dataOf(node: { data?: unknown }): Record<string, unknown> {
  return (node.data ?? {}) as Record<string, unknown>;
}

function differs(
  a: { data?: unknown },
  b: { data?: unknown },
  keys: ReadonlySet<string>,
  equal: (a: unknown, b: unknown) => boolean,
): boolean {
  const before = dataOf(a);
  const after = dataOf(b);
  for (const key of keys) if (!equal(before[key], after[key])) return true;
  return false;
}

/**
 * The nodes whose saved content a batch changed or created, each with
 * whether it changed the body (the fields the content revision covers):
 * every node the batch names a revision for, every inserted node, and every
 * replaced node of which a content field differs. `rows` are whole-node
 * rows (`expandNodeRows`); `local` is this page's node for an insertion it
 * already shows. Values are compared with `equal`: JSON transport gives
 * unchanged keywords and provenance separate object identities.
 */
export function contentChangesOf(
  rows: readonly Delta[],
  revisions: Readonly<Record<string, string>> | undefined,
  local: (nodeId: string) => { data?: unknown } | undefined,
  equal: (a: unknown, b: unknown) => boolean,
): Map<string, boolean> {
  const changes = new Map<string, boolean>(
    Object.keys(revisions ?? {}).map((id) => [id, false]),
  );
  const note = (id: string, body: boolean): void => {
    changes.set(id, changes.get(id) === true || body);
  };
  for (const row of rows) {
    if (row.type === 'INSERT_NODE') {
      const shown = local(row.node.id);
      note(
        row.node.id,
        !shown || differs(shown, row.node, BODY_CONTENT_KEYS, equal),
      );
    } else if (
      row.type === 'REPLACE_NODE' &&
      differs(row.prev, row.next, NODE_CONTENT_KEYS, equal)
    ) {
      note(row.next.id, differs(row.prev, row.next, BODY_CONTENT_KEYS, equal));
    }
  }
  return changes;
}
