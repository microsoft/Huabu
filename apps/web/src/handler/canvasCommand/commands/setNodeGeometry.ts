import { noop, type CommandDefinition } from './types';
import { fitFrames, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_GEOMETRY' }>;

const setNodeGeometry: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'caller',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state);

    const updateMap = new Map(
      cmd.items.map((item) => [item.nodeId as string, item]),
    );
    const affectedFrameIds = new Set<string>();

    let nextNodes = state.nodes.map((n) => {
      const update = updateMap.get(n.id);
      if (!update) return n;

      let updated = n;
      if (update.position) {
        updated = { ...updated, position: update.position };
      }
      if (update.size) {
        const nextStyle = {
          ...updated.style,
          width: update.size.width,
        };
        if (typeof update.size.height === 'number') {
          nextStyle.height = update.size.height;
        } else {
          delete nextStyle.height;
        }

        // Mirror the explicitly-set dimensions into `measured` so the
        // immediately-following `fitFrames` pass sees the new size. Without
        // this the parent frame would fit to the *previous* size (one step
        // behind) because `getNodeSize` prefers `measured` over `style`, and
        // ReactFlow's ResizeObserver hasn't reconciled the DOM yet at this
        // point. The RO will re-write the same number on the next frame, so
        // there's no jitter.
        //
        // For `height: undefined` (clearing a pinned height to revert to
        // content-driven sizing, e.g. note auto-fit) we leave `measured.height`
        // alone — the new content height is unknown until the next render,
        // and overwriting with 0 here would briefly collapse the node.
        const prevMeasured = (updated.measured ?? {}) as {
          width?: number;
          height?: number;
        };
        const nextMeasured: { width?: number; height?: number } = {
          ...prevMeasured,
          width: update.size.width,
        };
        if (typeof update.size.height === 'number') {
          nextMeasured.height = update.size.height;
        }

        updated = {
          ...updated,
          style: nextStyle,
          measured: nextMeasured,
        };
      }
      if (updated.parentId) affectedFrameIds.add(updated.parentId);
      return updated;
    });

    // Auto-resize parent frames (only when auto-layout is on).
    if (state.autoLayoutEnabled && affectedFrameIds.size > 0) {
      nextNodes = fitFrames(nextNodes as NestableNode[], affectedFrameIds);
    }

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
    };
  },
};

export default setNodeGeometry;
