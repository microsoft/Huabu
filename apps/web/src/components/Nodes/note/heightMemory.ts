/**
 * @file In-memory "last pinned fixed height" per note node.
 *
 * Lives outside `canvasStore` so the store stays focused on canvas state.
 * Used by `setNoteHeightMode` (auto → fixed) to restore the most recently
 * observed pinned height instead of snapping to the current rendered
 * measurement — a "collapse → expand → collapse" round-trip should bring
 * the node back to exactly the size it had before.
 *
 * Lifetime: current browser session only. Not persisted to canvas data,
 * not synced across tabs. After reload, `useTrackNoteFixedHeight` re-seeds
 * the memory from any note that mounts already in fixed mode (initial
 * `style.height` capture), so the round-trip still works within ordinary
 * interaction. Nodes that are never opened (e.g. virtualized out the
 * whole session) keep no memory and fall back to the rendered measurement.
 *
 * Not cleared on node deletion — the leak is bounded by the number of
 * note ids the user has touched this session.
 */

import { useStore } from '@xyflow/react';
import { useEffect } from 'react';

const memory = new Map<string, number>();

/**
 * Record the latest pinned height for a note. Silently rejects
 * non-finite or non-positive values.
 */
export function recordNoteFixedHeight(nodeId: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  memory.set(nodeId, height);
}

/** Read the most recently pinned height for a note, if any. */
export function getNoteFixedHeight(nodeId: string): number | undefined {
  return memory.get(nodeId);
}

/**
 * Mount-scoped tracker that records `style.height` into the shared
 * memory whenever the given note holds a pinned (numeric) height.
 *
 * Skips writes when the node is in auto mode (`style.height` cleared)
 * so the most recently observed pinned value is preserved across
 * auto ↔ fixed round-trips. Captures values from any source — toolbar
 * input, drag-resize handle, programmatic `setNodeGeometry`, undo /
 * redo — because it only watches the resolved store value.
 *
 * Intended to be called once from `NoteNode` for each note node. The
 * single mount point is enough because every entry path that pins a
 * height ultimately writes to `style.height` (which this tracks),
 * regardless of which UI triggered it.
 */
export function useTrackNoteFixedHeight(nodeId: string): void {
  const styleHeight = useStore(
    (s) => s.nodeLookup.get(nodeId)?.style?.height as number | undefined,
  );
  useEffect(() => {
    if (typeof styleHeight === 'number') {
      recordNoteFixedHeight(nodeId, styleHeight);
    }
  }, [nodeId, styleHeight]);
}
