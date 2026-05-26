import { noop, type CommandDefinition } from './types.js';
import {
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_LAYOUT_MODES,
} from '../../types/canvas/node.js';
import { clampGridCount } from '../autoLayout/gridLayout.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'SET_FRAME_LAYOUT' }>;

/**
 * `SET_FRAME_LAYOUT` — change a frame's `layoutMode` and (optionally)
 * `gridCount`. The executor's end-of-batch structured-relayout pass
 * picks up the affected frame and:
 *  - reflows children into tracks when switching to `column` / `row`;
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
    requiresEdgeReroute: false,
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
    };

    // Resolve the next gridCount:
    //  - explicit caller value wins (clamped);
    //  - else when entering / staying in a grid mode, keep the prior
    //    value or fall back to the default;
    //  - `free` mode doesn't use gridCount, but we preserve any
    //    previously stored value so flipping back into a grid mode
    //    remembers the user's last choice.
    const isGridMode = cmd.mode === 'column' || cmd.mode === 'row';
    const nextGridCount =
      typeof cmd.gridCount === 'number'
        ? clampGridCount(cmd.gridCount)
        : isGridMode
          ? (prior.gridCount ?? FRAME_GRID_DEFAULT_COUNT)
          : prior.gridCount;

    // No-op short-circuit when nothing changed.
    if (prior.layoutMode === cmd.mode && prior.gridCount === nextGridCount) {
      return noop(state, 'no-op');
    }

    const nextNodes = state.nodes.map((n) => {
      if (n.id !== cmd.frameId) return n;
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const nextData: Record<string, unknown> = {
        ...dataRec,
        layoutMode: cmd.mode,
      };
      if (typeof nextGridCount === 'number') {
        nextData.gridCount = nextGridCount;
      }
      return { ...n, data: nextData };
    });

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      mutatedNodes: nextNodes.filter((n) => n.id === cmd.frameId),
      affectedFrameIds: [cmd.frameId as string],
    };
  },
};

export default setFrameLayout;
