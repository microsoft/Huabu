import { noop, type CommandDefinition } from './types.js';
import {
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_LAYOUT_MODES,
  FRAME_SIZING_MODES,
  type FrameSizing,
} from '../../types/canvas/node.js';
import { clampGridCount } from '../autoLayout/gridLayout.js';

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
      sizing?: FrameSizing;
    };

    // Resolve the next gridCount:
    //  - explicit caller value wins (clamped);
    //  - else when entering / staying in a grid mode, keep the prior
    //    value or fall back to the default;
    //  - `free` mode doesn't use gridCount, but we preserve any
    //    previously stored value so flipping back into a grid mode
    //    remembers the user's last choice.
    const isGridMode =
      cmd.mode === 'column' || cmd.mode === 'row' || cmd.mode === 'grid';
    const nextGridCount =
      typeof cmd.gridCount === 'number'
        ? clampGridCount(cmd.gridCount)
        : isGridMode
          ? (prior.gridCount ?? FRAME_GRID_DEFAULT_COUNT)
          : prior.gridCount;

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

    // No-op short-circuit when nothing changed. Cell assignments always
    // count as a change: they are an explicit instruction, and letting
    // them ride on the layout fields being different would silently drop
    // them whenever a caller re-pins cells without touching the mode.
    if (
      !cellById &&
      prior.layoutMode === cmd.mode &&
      prior.gridCount === nextGridCount &&
      prior.sizing === nextSizing
    ) {
      return noop(state, 'no-op');
    }

    const nextNodes = state.nodes.map((n) => {
      if (n.id !== cmd.frameId) {
        const cell = cellById?.get(n.id);
        // Only direct children of this frame can hold one of its cells.
        if (!cell || n.parentId !== cmd.frameId) return n;
        const dataRec = (n.data ?? {}) as Record<string, unknown>;
        const nextData: Record<string, unknown> = { ...dataRec };
        // The legacy single index would out-rank nothing here, but it
        // would linger and contradict the cell the caller just set.
        delete nextData.frameSlot;
        if (typeof cell.column === 'number') {
          nextData.frameColumn = Math.max(0, Math.round(cell.column));
        }
        if (typeof cell.row === 'number') {
          nextData.frameRow = Math.max(0, Math.round(cell.row));
        }
        return { ...n, data: nextData };
      }
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const nextData: Record<string, unknown> = {
        ...dataRec,
        layoutMode: cmd.mode,
      };
      if (typeof nextGridCount === 'number') {
        nextData.gridCount = nextGridCount;
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
        (n) => n.id === cmd.frameId || cellById?.has(n.id),
      ),
      affectedFrameIds: [cmd.frameId as string],
    };
  },
};

export default setFrameLayout;
