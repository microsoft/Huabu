/**
 * Resize-preview slice for `useCanvasStore`.
 *
 * Co-locates every action and transient module-state involved in the
 * three sub-problems that fire during a resize gesture:
 *
 *   A. Parent-frame dashed overlay (`updateResizePreview` /
 *      `endResizePreview`) — visual only, writes
 *      `gesturePreviewStore.frameFitPreviews`. Does NOT touch
 *      canvas nodes.
 *
 *   B. Canonical geometry dispatch during the gesture
 *      (`previewResizeGeometry`) — the gesture-tick sibling of
 *      `setNodeGeometry`. Routes through the same `RESIZE_NODE`
 *      command pipeline so the column/row grid solver re-runs every
 *      tick, but re-arms the gesture-snapshot flag so preview ticks
 *      collapse into the single undo entry taken at
 *      `onNodeResizeStart`. This is the **only** geometry sink
 *      during a resize — `applyFrameResizeScale` routes through
 *      it too.
 *
 *   C. Child baseline scaling (`captureFrameResizeSnapshot` /
 *      `applyFrameResizeScale` / `clearFrameResizeSnapshot`) —
 *      captures direct children's pre-gesture geometry so the handler
 *      can scale them proportionally each tick. Used for **every**
 *      layout mode: `free` keeps the scaled child positions; the
 *      structured (`column` / `row`) grid solver re-packs the scaled
 *      children at the end of each tick's batch, so the
 *      content-driven frame size tracks the drag.
 *
 * All three groups share the same gesture lifecycle (start / tick /
 * end), so they belong together even though they touch different
 * stores.
 *
 * The transient rAF handle and free-frame snapshot live inside this
 * module's closure rather than on the Zustand store: no React
 * subscriber observes them, and routing them through `set` would
 * pump the autosave middleware many times per frame.
 *
 * @see canvasStore.ts — instantiates the controller as a module-
 *   level singleton and wires the methods into the store slice.
 * @see gesturePreviewStore.ts — owns the dashed-overlay state that
 *   group A writes into.
 */

import {
  computeFrameFit,
  getAbsolutePosition as getFrameAbsolutePosition,
  getNodeSize,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import { canvasHistoryManager } from '../../canvasHistoryManager';
import { useGesturePreviewStore } from '../../gesturePreviewStore';

import type { CanvasUiIntent } from '@/handler/canvasCommand/uiIntent';
import type { Node } from '@xyflow/react';

/**
 * Item shape accepted by `previewResizeGeometry` — mirrors the
 * RESIZE_NODE intent payload exactly.
 */
export type ResizeGeometryItem = {
  nodeId: string;
  size?: { width: number; height?: number };
  position?: { x: number; y: number };
};

/**
 * Slim slice of `RFState` the controller reads at fire time. Kept
 * structural (not `RFState`) so this module is free of store-type
 * coupling and import cycles.
 */
export type ResizePreviewSliceState = {
  autoLayoutEnabled: boolean;
  nodes: readonly Node[];
  dispatchUiIntent: (intent: CanvasUiIntent) => void;
};

/**
 * Public surface of the slice. Each method is a 1:1 replacement for
 * the same-named action that used to live inline on
 * `useCanvasStore`. `cancelPendingRaf` is an extra entry point used
 * by `endActiveDragSession` to tear down the resize-preview rAF when
 * the canvas unmounts mid-gesture.
 */
export type ResizePreviewController = {
  previewResizeGeometry(items: ResizeGeometryItem[]): void;
  updateResizePreview(nodeId: string): void;
  endResizePreview(): void;
  captureFrameResizeSnapshot(frameId: string): void;
  applyFrameResizeScale(
    width: number,
    height: number,
    x: number,
    y: number,
  ): void;
  clearFrameResizeSnapshot(): void;
  /**
   * Cancel any pending resize-preview rAF without clearing the
   * dashed overlay. Used by `endActiveDragSession`, which has its
   * own (drag-shared) `clearFrameFitPreview` call.
   */
  cancelPendingRaf(): void;
};

/**
 * Snapshot of a frame's direct children captured at the start of a
 * resize gesture. {@link ResizePreviewController.applyFrameResizeScale}
 * reads these to compute a proportional scale on every preview tick.
 */
type FrameResizeChildSnapshot = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type FrameResizeSnapshot = {
  frameId: string;
  frameWidth: number;
  frameHeight: number;
  children: FrameResizeChildSnapshot[];
};

/**
 * Build a {@link ResizePreviewController}.
 *
 * @param opts.getState - lazy getter for the store slice fields the
 *   controller needs. Re-invoked on every fire so HMR / store swaps
 *   work transparently.
 */
export function createResizePreviewController(opts: {
  getState: () => ResizePreviewSliceState;
}): ResizePreviewController {
  // rAF handle for `updateResizePreview`. NodeResizer's onResize
  // callback may fire well above 60 Hz on high-refresh displays, and
  // `computeFrameFit` walks every node + descendant of the parent
  // frame. Coalescing per-frame calls into a single rAF callback caps
  // the work at one fit-pass per paint without dropping any
  // user-visible state — the rAF callback re-reads the latest store
  // snapshot when it actually runs.
  let rafId: number | null = null;

  let freeSnapshot: FrameResizeSnapshot | null = null;

  const cancelPendingRaf = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  // Defined as a local function so `applyFrameResizeScale` can
  // call it directly without relying on `this`-binding (the store
  // surfaces these methods as plain property values, which would
  // strip `this` at call time).
  const previewResizeGeometry = (items: ResizeGeometryItem[]) => {
    // Dispatch the live preview through the normal command pipeline
    // so the structured-frame solver (column/row) and any other
    // post-effects re-run on every tick. Re-arming the gesture
    // snapshot flag AFTER dispatch keeps it `true` for the next
    // tick (and the final NodeWrapper.handleResizeEnd commit),
    // suppressing the executor's "snapshot:'caller' without
    // beginGesture()" warning. The original undo snapshot was
    // taken once at `onNodeResizeStart`; preview ticks don't add
    // new snapshots — they all collapse into that single entry.
    opts.getState().dispatchUiIntent({ type: 'RESIZE_NODE', items });
    canvasHistoryManager.markGestureSnapshot();
  };

  return {
    previewResizeGeometry,

    updateResizePreview(nodeId) {
      const { autoLayoutEnabled } = opts.getState();
      if (!autoLayoutEnabled) return;

      // Cancel the prior rAF handle (rather than gating on "already
      // scheduled") so we always recompute against the latest store
      // snapshot — RF may have committed several intermediate dim
      // changes via applyNodeChanges between this call and the rAF
      // tick.
      cancelPendingRaf();
      rafId = requestAnimationFrame(() => {
        rafId = null;

        const { nodes } = opts.getState();
        const node = (nodes as NestableNode[]).find((n) => n.id === nodeId);
        if (!node?.parentId) return;
        const frame = (nodes as NestableNode[]).find(
          (n) => n.id === node.parentId,
        );
        if (!frame || frame.type !== 'frame') return;

        const fit = computeFrameFit(nodes as NestableNode[], node.parentId);
        if (!fit) return;

        let absX = fit.position.x;
        let absY = fit.position.y;
        if (frame.parentId) {
          const parentAbsPos = getFrameAbsolutePosition(
            nodes as NestableNode[],
            frame.parentId,
          );
          if (parentAbsPos) {
            absX += parentAbsPos.x;
            absY += parentAbsPos.y;
          }
        }

        useGesturePreviewStore.getState().setFrameFitPreviews([
          {
            frameId: node.parentId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
          },
        ]);
      });
    },

    endResizePreview() {
      cancelPendingRaf();
      useGesturePreviewStore.getState().clearFrameFitPreview();
    },

    captureFrameResizeSnapshot(frameId) {
      const { nodes } = opts.getState();
      const frame = nodes.find((n) => n.id === frameId);
      if (!frame || frame.type !== 'frame') {
        freeSnapshot = null;
        return;
      }
      const frameSize = getNodeSize(frame);
      if (frameSize.width <= 0 || frameSize.height <= 0) {
        freeSnapshot = null;
        return;
      }
      const children: FrameResizeChildSnapshot[] = [];
      for (const node of nodes) {
        if (node.parentId !== frameId) continue;
        const ns = getNodeSize(node);
        children.push({
          id: node.id,
          x: node.position.x,
          y: node.position.y,
          width: ns.width,
          height: ns.height,
        });
      }
      freeSnapshot = {
        frameId,
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        children,
      };
    },

    applyFrameResizeScale(width, height, x, y) {
      const snap = freeSnapshot;
      if (!snap) return;
      if (snap.frameWidth <= 0 || snap.frameHeight <= 0) return;
      const sx = width / snap.frameWidth;
      const sy = height / snap.frameHeight;
      // Always include the frame's NEW local origin in the batch so
      // non-BR handle drags don't depend on the `onNodesChange`
      // snap-mirror running in a separate pass to commit the frame's
      // position. For BR-handle drags `(x, y)` simply equal the
      // gesture-start values and the dispatch is a no-op for the
      // frame's position.
      const items: ResizeGeometryItem[] = [
        {
          nodeId: snap.frameId,
          size: { width, height },
          position: { x, y },
        },
      ];
      for (const child of snap.children) {
        items.push({
          nodeId: child.id,
          size: {
            width: Math.max(1, child.width * sx),
            height: Math.max(1, child.height * sy),
          },
          // Local positions scale uniformly with the frame regardless
          // of which handle is dragged: when the frame's own TL moves
          // (TL/T/L handles) the children's absolute positions follow
          // the frame so the user-visible content stays anchored at
          // the corner the handle is NOT moving.
          position: { x: child.x * sx, y: child.y * sy },
        });
      }
      // Route through the canonical dispatch path so the gesture
      // snapshot flag stays re-armed. For structured (column/row)
      // frames the grid solver re-packs the scaled children at the
      // end of the batch; for free frames the scaled positions stick.
      previewResizeGeometry(items);
    },

    clearFrameResizeSnapshot() {
      freeSnapshot = null;
    },

    cancelPendingRaf,
  };
}
