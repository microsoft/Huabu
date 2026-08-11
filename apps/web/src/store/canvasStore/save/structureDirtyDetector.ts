// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Decides whether a store mutation actually warrants a structure save
 * (`PUT /api/canvas/:id`). Pure functions only — no timers, no I/O,
 * no store dependency. Imported by `canvasStore`'s autosave
 * middleware.
 *
 * The structure save uses optimistic concurrency control via
 * `canvas.version`, so we must NOT bump the version for changes that
 * are persisted through other endpoints (per-node content PUTs) or
 * are pure UI state (selection, drag handles). This module is the
 * gate that filters those out.
 */

import { NODE_CONTENT_KEYS } from './nodeContentFields';

import type { Node } from '@xyflow/react';

/**
 * Top-level `Node` keys the structure PUT does not care about.
 * `data` is diffed separately below (with its own ignore set); the
 * rest are ReactFlow internal UI state. Most of these bypass the
 * autosave gate entirely via `_setStateNoAutosave`; they remain here
 * as a defensive filter for the few engine paths that still touch
 * them (e.g. `SET_NODE_SELECTION` flipping `selected`).
 */
const NODE_TOPLEVEL_IGNORE: ReadonlySet<string> = new Set([
  'data',
  'dragging',
  'selected',
  'measured',
  'handles',
  'internals',
]);

/**
 * Reference-diff two records, ignoring an allow-list of keys. Returns
 * `true` on the first key whose values differ by `!==`, or when one
 * side has a non-ignored key the other does not.
 */
function recordsDifferIgnoring(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  ignore: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  for (const k of Object.keys(a)) {
    if (ignore.has(k)) continue;
    seen.add(k);
    if (a[k] !== b[k]) return true;
  }
  for (const k of Object.keys(b)) {
    if (ignore.has(k)) continue;
    if (!seen.has(k)) return true;
  }
  return false;
}

/**
 * Decide whether two `nodes` arrays differ in any field the structure
 * PUT actually cares about (id, type, position, parenthood, dimensions,
 * non-content `data` keys).
 *
 * Returns `false` when the only differences live inside
 * {@link NODE_CONTENT_KEYS} (or {@link NODE_TOPLEVEL_IGNORE}) — those
 * edits ride the per-node content PUT (or are pure UI state) and must not
 * schedule a second structure commit. Without this gate every keystroke
 * inside the editor would produce a new `nodes` array reference and
 * trigger a full structure save with an empty diff. The node endpoint can
 * still advance the global version without changing structureRevision.
 *
 * `position` is compared by reference because after the Plan A cleanup
 * every 60 fps drag tick bypasses the gate via `_setStateNoAutosave`;
 * the only `position` mutations that reach here are engine commands
 * (`SET_NODE_GEOMETRY`, `ALIGN_NODES`, `SET_NODE_PARENT`) which always
 * change the underlying values, not just the object reference.
 */
export function haveNodesChangedStructurally(
  prev: readonly Node[],
  next: readonly Node[],
): boolean {
  if (prev === next) return false;
  const len = next.length;
  if (prev.length !== len) return true;
  for (let i = 0; i < len; i++) {
    const before = prev[i];
    const after = next[i];
    if (before === after) continue;
    if (!before || !after) return true;
    if (before.id !== after.id) return true;
    if (
      recordsDifferIgnoring(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        NODE_TOPLEVEL_IGNORE,
      )
    ) {
      return true;
    }
    const beforeData = (before.data ?? {}) as Record<string, unknown>;
    const afterData = (after.data ?? {}) as Record<string, unknown>;
    if (
      beforeData !== afterData &&
      recordsDifferIgnoring(beforeData, afterData, NODE_CONTENT_KEYS)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Persisted-in-structure-PUT fields. Diffed by reference; `nodes` is
 * a special case that drills into {@link haveNodesChangedStructurally}
 * to avoid spurious version bumps on content-only edits.
 */
const PERSISTED_KEYS = ['nodes', 'edges', 'canvasTitle'] as const;
type PersistedKey = (typeof PERSISTED_KEYS)[number];

/**
 * Minimal view of the canvas store needed for dirty detection. Kept
 * structural (not `RFState`) so this module does not depend on the
 * store type and stays free of import cycles.
 */
export type StructureDirtyView = {
  nodes: readonly Node[];
  edges: readonly unknown[];
  canvasTitle: string;
};

/**
 * Decide whether `(prev → next)` includes a change that should
 * trigger a debounced structure save. Returns `false` when the diff
 * is empty *or* lives entirely inside per-node content / UI state.
 *
 * Caller is responsible for the `!prev.isLoading` and other
 * non-persistence gates; this function only looks at the persisted
 * field diff.
 */
export function shouldScheduleStructureSave(
  prev: StructureDirtyView,
  next: StructureDirtyView,
): boolean {
  return (PERSISTED_KEYS as readonly PersistedKey[]).some((k) => {
    if (k === 'nodes') {
      return haveNodesChangedStructurally(prev.nodes, next.nodes);
    }
    return prev[k] !== next[k];
  });
}
