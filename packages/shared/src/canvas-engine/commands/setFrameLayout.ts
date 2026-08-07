// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import {
  FRAME_LAYOUT_MODES,
  FRAME_SIZING_MODES,
  type FrameSizing,
} from '../../types/canvas/node.js';
import { clampGridCount, planGridReflow } from '../autoLayout/gridLayout.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'SET_FRAME_LAYOUT' }>;

/**
 * `SET_FRAME_LAYOUT` — change a frame's `layoutMode` and (optionally)
 * `gridCount`. The executor's end-of-batch structured-relayout pass
 * picks up the affected frame and:
 *  - reflows children into tracks when switching to `column` / `row` /
 *    `grid`;
 *  - resizes the frame to fit its content;
 *  - cascades the size change to ancestor frames.
 *
 * The handler itself only writes the two `data` fields and reports
 * the frame in `affectedFrameIds`; all layout math lives in the
 * shared `applyStructuredFrameRelayout` pass (see `executor.ts`).
 */
const setFrameLayout: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    const frame = state.nodes.find((n) => n.id === cmd.frameId);
    if (!frame || frame.type !== 'frame') return noop(state, 'not-found');
    if (!FRAME_LAYOUT_MODES.includes(cmd.mode)) {
      return noop(state, 'invalid-target');
    }

    const prior = (frame.data ?? {}) as {
      layoutMode?: (typeof FRAME_LAYOUT_MODES)[number];
      gridCount?: number;
      gridRowCount?: number;
      sizing?: FrameSizing;
    };

    // Resolve the next gridCount:
    //  - explicit caller value wins (clamped): naming a count IS the
    //    instruction to re-flow into that many tracks;
    //  - a mode CHANGE drops the stored count entirely, so the
    //    end-of-batch solver re-derives it from the children's current
    //    geometry. Inheriting it would re-flow the frame against a
    //    number chosen for a different axis, and defaulting to 1 (the
    //    old behaviour) flattened every arrangement into one track;
    //  - otherwise (same mode, no explicit count) the stored value is
    //    preserved so unrelated edits — a `sizing` flip, a cell pin —
    //    do not disturb the track structure.
    const modeChanged = prior.layoutMode !== cmd.mode;
    const nextGridCount =
      typeof cmd.gridCount === 'number'
        ? clampGridCount(cmd.gridCount)
        : modeChanged
          ? undefined
          : prior.gridCount;

    // The row floor follows the same rule as the column count: an
    // explicit value wins, a mode change drops it (a floor chosen for
    // one layout means nothing in another), otherwise it is preserved.
    // Only `grid` has row bands to put a floor under.
    const nextGridRowCount =
      cmd.mode !== 'grid'
        ? undefined
        : typeof cmd.gridRowCount === 'number'
          ? clampGridCount(cmd.gridRowCount)
          : modeChanged
            ? undefined
            : prior.gridRowCount;

    // Resolve the next sizing:
    //  - explicit caller value wins (validated against the enum);
    //  - else preserve the previously-stored value, so callers that
    //    don't touch the sizing axis (e.g. the gridCount stepper, the
    //    `setMode` toggle, the drag-stop track-compact dispatch) never
    //    silently reset a frame the user pinned to `'manual'`.
    //  PR 2: `column|row + manual` is supported — the structured
    //  solver re-packs children and leaves the user-pinned frame size
    //  alone; children may overflow the main axis (start-aligned).
    const explicitSizing =
      cmd.sizing && FRAME_SIZING_MODES.includes(cmd.sizing)
        ? cmd.sizing
        : undefined;
    const nextSizing: FrameSizing | undefined = explicitSizing ?? prior.sizing;

    const cellById = cmd.cells?.length
      ? new Map(cmd.cells.map((cell) => [cell.nodeId as string, cell]))
      : undefined;

    // A mode change invalidates the children's stored cells, so the solver
    // re-reads them from geometry instead of resolving new tracks against
    // indices assigned for the old structure. A `grid` column-count change is
    // deliberately not a reset — see `reflowPlan` below.
    const resetsCells = modeChanged;

    // Naming a column count for `grid` goes further than a reset: its
    // rows are persistent AND two-dimensional, so the new cells have to
    // be planned outright. See `planGridReflow`.
    const reflowPlan =
      cmd.mode === 'grid' && typeof cmd.gridCount === 'number'
        ? planGridReflow(
            state.nodes,
            cmd.frameId as string,
            clampGridCount(cmd.gridCount),
          )
        : undefined;

    // No-op short-circuit when nothing changed. Cell assignments always
    // count as a change: they are an explicit instruction, and letting
    // them ride on the layout fields being different would silently drop
    // them whenever a caller re-pins cells without touching the mode.
    if (
      !cellById &&
      !resetsCells &&
      !reflowPlan &&
      prior.layoutMode === cmd.mode &&
      prior.gridCount === nextGridCount &&
      prior.gridRowCount === nextGridRowCount &&
      prior.sizing === nextSizing
    ) {
      return noop(state, 'no-op');
    }

    const touchedChildIds = new Set<string>();
    const nextNodes = state.nodes.map((n) => {
      if (n.id !== cmd.frameId) {
        const cell = cellById?.get(n.id);
        // Only direct children of this frame can hold one of its cells.
        if (n.parentId !== cmd.frameId) return n;
        const planned = reflowPlan?.get(n.id);
        if (!cell && !planned && !resetsCells) return n;
        const dataRec = (n.data ?? {}) as Record<string, unknown>;
        const nextData: Record<string, unknown> = { ...dataRec };
        // The legacy single index would out-rank nothing here, but it
        // would linger and contradict the cell the caller just set.
        delete nextData.frameSlot;
        if (resetsCells) {
          delete nextData.frameColumn;
          delete nextData.frameRow;
        }
        if (planned) {
          nextData.frameColumn = planned.column;
          nextData.frameRow = planned.row;
        }
        // An explicit `cells` payload outranks the planned re-flow.
        if (typeof cell?.column === 'number') {
          nextData.frameColumn = Math.max(0, Math.round(cell.column));
        }
        if (typeof cell?.row === 'number') {
          nextData.frameRow = Math.max(0, Math.round(cell.row));
        }
        // A child whose cell the command did not actually change keeps
        // its identity. Both a mode change and a `cells` payload address
        // every child of the frame, but most of them usually land where
        // they already were — and a node that appears in `mutatedNodes`
        // is re-persisted and re-broadcast whether or not it moved.
        if (
          nextData.frameColumn === dataRec.frameColumn &&
          nextData.frameRow === dataRec.frameRow &&
          !('frameSlot' in dataRec)
        ) {
          return n;
        }
        touchedChildIds.add(n.id);
        return { ...n, data: nextData };
      }
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const nextData: Record<string, unknown> = {
        ...dataRec,
        layoutMode: cmd.mode,
      };
      if (typeof nextGridCount === 'number') {
        nextData.gridCount = nextGridCount;
      } else {
        // Dropped on a mode change so the solver derives the count from
        // geometry; it writes the resolved value back afterwards.
        delete nextData.gridCount;
      }
      if (typeof nextGridRowCount === 'number') {
        nextData.gridRowCount = nextGridRowCount;
      } else {
        delete nextData.gridRowCount;
      }
      if (nextSizing) {
        nextData.sizing = nextSizing;
      } else {
        // Reached only when neither the caller nor the prior data
        // carried a `sizing` value — the field was already absent on
        // `dataRec`, so the spread above left it unset. The delete is
        // a defensive no-op that documents "no sizing entry should
        // exist on this frame yet"; it does NOT clear a user-pinned
        // `'manual'` because `prior.sizing` would have populated
        // `nextSizing` via the `?? prior.sizing` fallback above.
        delete nextData.sizing;
      }
      return { ...n, data: nextData };
    });

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      mutatedNodes: nextNodes.filter(
        (n) => n.id === cmd.frameId || touchedChildIds.has(n.id),
      ),
      affectedFrameIds: [cmd.frameId as string],
    };
  },
};

export default setFrameLayout;
