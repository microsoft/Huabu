import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';

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
    // Parent frames whose child just had its explicit height cleared
    // (revert to content-driven sizing). The new content height is
    // unknown until the inline editor reflows + RF re-measures, so we
    // ask the executor's post-effect to refit after the next render
    // cycle.
    const deferredFitFrameIds = new Set<string>();

    const nextNodes = state.nodes.map((n) => {
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
        const heightCleared = typeof update.size.height !== 'number';
        if (!heightCleared) {
          nextStyle.height = update.size.height;
        } else {
          delete nextStyle.height;
        }

        // Mirror the explicitly-set dimensions into `measured` so the
        // executor's end-of-batch `fitFrames` pass sees the new size.
        // Without this the parent frame would fit to the *previous* size
        // (one step behind) because `getNodeSize` prefers `measured` over
        // `style`, and ReactFlow's ResizeObserver hasn't reconciled the
        // DOM yet at this point. The RO will re-write the same number on
        // the next frame, so there's no jitter.
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
        if (!heightCleared) {
          nextMeasured.height = update.size.height;
        }

        updated = {
          ...updated,
          style: nextStyle,
          measured: nextMeasured,
        };

        // Track the parent for a post-commit refit only when the child's
        // height was cleared and auto-layout is on. Otherwise the executor's
        // sync `fitFrames` pass is sufficient.
        if (heightCleared && state.autoLayoutEnabled && updated.parentId) {
          deferredFitFrameIds.add(updated.parentId);
        }
      }
      if (updated.parentId) affectedFrameIds.add(updated.parentId);
      return updated;
    });

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
      ...(deferredFitFrameIds.size > 0
        ? { deferredFitFrameIds: Array.from(deferredFitFrameIds) }
        : {}),
    };
  },
};

export default setNodeGeometry;
