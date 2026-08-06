// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  getFrameSizing,
  getNodeSize,
  getStructuredFrameGutterPlan,
  type NestableNode,
  type StructuredGutterSizes,
} from '@huabu/shared/canvas-engine';

import {
  getNodeFontFit,
  refitFont,
  type NodeFontFit,
} from '@/utils/node/fontFit';

import { canvasHistoryManager } from '../../canvasHistoryManager';
import { useGesturePreviewStore } from '../../gesturePreviewStore';

import type { CanvasUiIntent } from '@/handler/canvasCommand/uiIntent';
import type { FrameSizing, NodeStyle } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

/**
 * Item shape accepted by `previewResizeGeometry` — mirrors the
 * RESIZE_NODE intent payload exactly.
 *
 * Both `size` and `position` are independently optional: omitting a
 * field means "leave that part of the node's geometry unchanged",
 * NOT "reset it". The manual-frame branch in `flushScale` relies on
 * this to move children's local positions (to compensate for a frame
 * origin shift) without touching their pinned width / height.
 */
export type ResizeGeometryItem = {
  nodeId: string;
  /** Omit to keep the node's current width / height. */
  size?: { width: number; height?: number };
  /** Omit to keep the node's current `(x, y)`. */
  position?: { x: number; y: number };
};

/**
 * Slim slice of `RFState` the controller reads at fire time. Kept
 * structural (not `RFState`) so this module is free of store-type
 * coupling and import cycles.
 */
export type ResizePreviewSliceState = {
  nodes: readonly Node[];
  edges: readonly Edge[];
  dispatchUiIntent: (intent: CanvasUiIntent) => void;
  /**
   * Silent (no-undo) node-data patch. Used to scale text-bearing
   * children's locked `data.style.fontSize` in step with the frame —
   * the same write path `useTextAutoSize` uses at a node's own
   * resize-end, so the cascade font change collapses into the
   * gesture's single undo entry.
   */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
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
  /**
   * Synchronously run any rAF-coalesced scale tick that is still
   * pending, then drop the queued rAF. Called at gesture end (before
   * {@link ResizePreviewController.clearFrameResizeSnapshot}) so the
   * final child-scaling tick — which the per-paint throttle in
   * {@link ResizePreviewController.applyFrameResizeScale} may have
   * coalesced away — isn't lost, which would otherwise leave children
   * one frame behind the frame's committed final size.
   */
  flushFrameResizeScale(): void;
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
  /**
   * The child's full `data.style` at gesture start. `patchNodeSilent`
   * replaces `data.style` wholesale, so we preserve every other field
   * (fontFamily, accent, colors, …) and only override `fontSize`.
   */
  style?: NodeStyle;
  /**
   * Content-aware font fit captured at gesture start (text + fontOpts +
   * inset). `null` for non-text nodes. Lets the cascade re-derive the
   * child's fontSize for its NEW box with the same pretext fit the node
   * uses for its own resize, instead of a crude `min(sx, sy)` multiplier
   * that ignores re-wrapping.
   */
  fontFit?: NodeFontFit | null;
};

type FrameResizeSnapshot = {
  frameId: string;
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
  /**
   * Sizing policy at gesture start. Drives the `flushScale` branch
   * (hug → scale children, manual → freeze child sizes and only
   * compensate their local positions for the frame's origin shift).
   */
  sizing: FrameSizing;
  gutters?: StructuredGutterSizes;
  children: FrameResizeChildSnapshot[];
};

function collectGutterSizes(
  plans: ReturnType<typeof getStructuredFrameGutterPlan>,
): StructuredGutterSizes | undefined {
  if (plans.length === 0) return undefined;
  const sizes: StructuredGutterSizes = {};
  for (const plan of plans) {
    const current = sizes[plan.axis];
    const values = current ? [...current] : [];
    values[plan.index] = plan.finalSize;
    sizes[plan.axis] = values;
  }
  return sizes;
}

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

  // Separate rAF handle + latest-wins payload for the geometry-scale
  // dispatch (`applyFrameResizeScale`). Kept distinct from `rafId` (the
  // overlay-fit handle) so cancelling one never drops the other:
  // `endResizePreview` cancels the overlay rAF but must NOT discard a
  // still-pending final scale tick — that one is flushed synchronously
  // at gesture end via `flushFrameResizeScale`.
  let scaleRafId: number | null = null;
  let pendingScale: {
    width: number;
    height: number;
    x: number;
    y: number;
  } | null = null;

  let freeSnapshot: FrameResizeSnapshot | null = null;

  // Last fontSize actually written per child during the current
  // gesture. Lets `flushScale` skip redundant `patchNodeSilent` calls
  // when the rounded scaled font is unchanged across coalesced ticks,
  // keeping store churn (and autosave middleware passes) minimal.
  const lastAppliedFont = new Map<string, number>();

  // Cancels only the overlay-fit rAF (`updateResizePreview`).
  const cancelOverlayRaf = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  // Cancels only the geometry-scale rAF and drops its queued payload.
  const cancelScaleRaf = () => {
    if (scaleRafId !== null) {
      cancelAnimationFrame(scaleRafId);
      scaleRafId = null;
    }
    pendingScale = null;
  };

  // Public teardown (mid-gesture canvas unmount): drop BOTH rAFs and
  // any queued scale payload. No flush — we're tearing down.
  const cancelPendingRaf = () => {
    cancelOverlayRaf();
    cancelScaleRaf();
  };

  // Defined as a local function so `applyFrameResizeScale` can
  // call it directly without relying on `this`-binding (the store
  // surfaces these methods as plain property values, which would
  // strip `this` at call time).
  const previewResizeGeometry = (
    items: ResizeGeometryItem[],
    frozenStructuredGutters?: ReadonlyMap<string, StructuredGutterSizes>,
  ) => {
    // Dispatch the live preview through the normal command pipeline
    // so the structured-frame solver (column/row) and any other
    // post-effects re-run on every tick. Re-arming the gesture
    // snapshot flag AFTER dispatch keeps it `true` for the next
    // tick (and the final NodeWrapper.handleResizeEnd commit),
    // suppressing the executor's "snapshot:'caller' without
    // beginGesture()" warning. The original undo snapshot was
    // taken once at `onNodeResizeStart`; preview ticks don't add
    // new snapshots — they all collapse into that single entry.
    //
    // `preview: true` flags this as a transient gesture tick so
    // `dispatchUiIntent` runs the commands but skips behavioural-event
    // + recent-action recording. Without it, the rAF-coalesced ticks
    // would each persist an event (≈ one per paint), so a single drag
    // emitted many RESIZE events. The authoritative single event is
    // recorded by the end-of-gesture `setNodeGeometry` commit.
    opts.getState().dispatchUiIntent({
      type: 'RESIZE_NODE',
      items,
      preview: true,
      frozenStructuredGutters,
    });
    canvasHistoryManager.markGestureSnapshot();
  };

  // Actual geometry computation + dispatch for ONE scale tick. Reads
  // the captured child baselines and either scales them proportionally
  // (hug) or freezes their absolute position (manual) against the
  // frame's new size, dispatching frame + children as a single batch.
  // Invoked from the rAF callback in `applyFrameResizeScale` (per
  // paint) and synchronously from `flushFrameResizeScale` at gesture
  // end. No-op once the snapshot has been cleared.
  const flushScale = (width: number, height: number, x: number, y: number) => {
    const snap = freeSnapshot;
    if (!snap) return;
    if (snap.frameWidth <= 0 || snap.frameHeight <= 0) return;
    const frameWidth = width;
    const frameHeight = height;
    const frameX = x;
    const frameY = y;
    // Always include the frame's NEW local origin in the batch so
    // non-BR handle drags don't depend on the `onNodesChange`
    // snap-mirror running in a separate pass to commit the frame's
    // position. For BR-handle drags `(x, y)` simply equal the
    // gesture-start values and the dispatch is a no-op for the
    // frame's position.
    const items: ResizeGeometryItem[] = [
      {
        nodeId: snap.frameId,
        size: { width: frameWidth, height: frameHeight },
        position: { x: frameX, y: frameY },
      },
    ];
    if (snap.sizing === 'manual') {
      // Manual frames own their own box. Children must keep their
      // pre-gesture size AND absolute position. Local positions are
      // stored relative to the frame's origin, so if the frame's TL
      // moved (TL/TR/BL/T/L handle drags), compensate each child's
      // local position by the inverse delta. BR/B/R-handle drags
      // leave `(frameX, frameY)` equal to the gesture-start origin
      // and the compensation is a no-op.
      const dx = frameX - snap.frameX;
      const dy = frameY - snap.frameY;
      for (const child of snap.children) {
        items.push({
          nodeId: child.id,
          // No `size`: keep the pre-gesture pinned width/height.
          position: {
            x: child.x - dx,
            y: child.y - dy,
          },
        });
      }
      previewResizeGeometry(
        items,
        snap.gutters ? new Map([[snap.frameId, snap.gutters]]) : undefined,
      );
      return;
    }
    // ---- Hug branch: per-axis scaling ------------------------------
    // Per-axis (sx, sy) for all hug layouts (free, column, row). For
    // structured (`column` / `row`) frames the grid solver derives
    // padding + gap per-axis (widths drive padX + interGapX, heights
    // drive padY + intraGapY — see
    // `packages/shared/src/canvas-engine/autoLayout/gridLayout.ts`),
    // so scaling all child widths by `sx` makes the resulting frame
    // width = `oldW × sx` exactly, and same for height with `sy`.
    // Single-edge drags therefore track the pointer pixel-perfect on
    // the dragged axis and leave the orthogonal axis untouched —
    // children scale per-axis along with the frame. Diagonal drags
    // stretch children per-axis (children may look non-square); users
    // who want uniform scaling can hold Shift (TODO: wire up the
    // modifier).
    const sx = width / snap.frameWidth;
    const sy = height / snap.frameHeight;
    for (const child of snap.children) {
      const childWidth = Math.max(1, child.width * sx);
      const childHeight = Math.max(1, child.height * sy);
      items.push({
        nodeId: child.id,
        size: {
          width: childWidth,
          height: childHeight,
        },
        // Local positions scale uniformly from the frame origin too,
        // so the relative gap between any two points (including the
        // gap between a child and the frame edge) scales by the same
        // ratio as their sizes. (Structured column / row frames ignore
        // these positions: the grid solver re-packs the scaled
        // children at the end of the batch.)
        position: {
          x: child.x * sx,
          y: child.y * sy,
        },
      });
    }
    // Route through the canonical dispatch path so the gesture
    // snapshot flag stays re-armed. For structured (column/row)
    // frames the grid solver re-packs the scaled children at the
    // end of the batch; for free frames the scaled positions stick.
    const scaledGutters = snap.gutters
      ? {
          x: snap.gutters.x?.map((size) => size * sx),
          y: snap.gutters.y?.map((size) => size * sy),
        }
      : undefined;
    previewResizeGeometry(
      items,
      scaledGutters ? new Map([[snap.frameId, scaledGutters]]) : undefined,
    );

    // Re-derive text-bearing children's locked fontSize for their NEW
    // box using the same content-aware pretext fit the node uses for its
    // own resize (`computeFontSizeForHeight` via `useTextAutoSize`), so a
    // cascaded frame resize and a direct node resize land on the same
    // size. A plain `min(sx, sy)` multiplier handles text poorly: it
    // ignores re-wrapping, so widening a node while keeping its height
    // would cap the font to the smaller axis even though the rewrapped
    // text could grow.
    //
    // EVERY text-bearing child is refit — including nodes that did not
    // yet persist a locked `fontSize`. `setNodeGeometry` pins each
    // child's `style.width`, so after the cascade an auto-sizing node is
    // no longer width-auto; its rendered font is then `lockedFontSize ??
    // baseFontSize` (16) and would stay 16 in the now-larger box unless
    // we lock a refitted size here — the same lock a direct node resize
    // would establish. Written via `patchNodeSilent` — the same silent
    // style-patch path `useTextAutoSize` uses at resize-end — so it
    // collapses into the gesture's single undo entry and the child's
    // height stays content-driven (re-derived from the new font).
    const patchNodeSilent = opts.getState().patchNodeSilent;
    for (const child of snap.children) {
      if (!child.fontFit) continue;
      const childWidth = Math.max(1, child.width * sx);
      const childHeight = Math.max(1, child.height * sy);
      const next = refitFont(child.fontFit, childWidth, childHeight);
      if (!Number.isFinite(next) || next <= 0) continue;
      if (lastAppliedFont.get(child.id) === next) continue;
      lastAppliedFont.set(child.id, next);
      patchNodeSilent(child.id, {
        style: { ...(child.style ?? {}), fontSize: next },
      });
    }
  };

  return {
    previewResizeGeometry,

    updateResizePreview(nodeId) {
      // Cancel the prior rAF handle (rather than gating on "already
      // scheduled") so we always recompute against the latest store
      // snapshot — RF may have committed several intermediate dim
      // changes via applyNodeChanges between this call and the rAF
      // tick.
      cancelOverlayRaf();
      rafId = requestAnimationFrame(() => {
        rafId = null;

        const { nodes } = opts.getState();
        const node = (nodes as NestableNode[]).find((n) => n.id === nodeId);
        if (!node?.parentId) return;
        const frame = (nodes as NestableNode[]).find(
          (n) => n.id === node.parentId,
        );
        if (!frame || frame.type !== 'frame') return;
        // Per-frame sizing gate: only `hug` parents preview a refit
        // around the resizing child. `manual` parents keep their
        // pinned size — there is nothing to reflow.
        if (getFrameSizing(frame) !== 'hug') return;

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
            // A resize gesture reshapes its parent frame in real time:
            // there is no "leaving" semantics here, so always paint it
            // as the active target so the user can see exactly which
            // frame is currently being reflowed.
            role: 'target',
          },
        ]);
      });
    },

    endResizePreview() {
      cancelOverlayRaf();
      useGesturePreviewStore.getState().clearFrameFitPreview();
    },

    captureFrameResizeSnapshot(frameId) {
      const { nodes, edges } = opts.getState();
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
      const sizing = getFrameSizing(frame);
      const gutters = collectGutterSizes(
        getStructuredFrameGutterPlan(
          nodes as NestableNode[],
          edges as Edge[],
          frameId,
        ),
      );
      // Children are always snapshotted — `manual` frames need them
      // too so `flushScale` can compensate child local positions for
      // the frame's origin shift (TL/TR/BL/T/L handles all move the
      // frame's `(x, y)`), keeping absolute child positions stable.
      const children: FrameResizeChildSnapshot[] = [];
      for (const node of nodes) {
        if (node.parentId !== frameId) continue;
        const ns = getNodeSize(node);
        const style = (node.data as { style?: NodeStyle } | undefined)?.style;
        children.push({
          id: node.id,
          x: node.position.x,
          y: node.position.y,
          width: ns.width,
          height: ns.height,
          style,
          fontFit: getNodeFontFit(node),
        });
      }
      // Fresh gesture — drop any stale per-child font dedupe state.
      lastAppliedFont.clear();
      freeSnapshot = {
        frameId,
        frameX: frame.position.x,
        frameY: frame.position.y,
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        sizing,
        gutters,
        children,
      };
    },

    applyFrameResizeScale(width, height, x, y) {
      // Coalesce per-pointermove ticks into a single dispatch per
      // paint. NodeResizer.onResize fires at the pointermove rate
      // (120 Hz+ on high-refresh displays); routing every tick straight
      // to `flushScale` would run the whole command pipeline + the
      // structured (column/row) grid solver that many times a second.
      // Store the latest target dims (latest-wins) and schedule one
      // rAF that consumes them. The authoritative final commit is the
      // `setNodeGeometry` in `NodeWrapper.handleResizeEnd`; the trailing
      // scale tick is run synchronously by `flushFrameResizeScale` at
      // gesture end so children never lag the frame's committed size.
      pendingScale = { width, height, x, y };
      if (scaleRafId !== null) return;
      scaleRafId = requestAnimationFrame(() => {
        scaleRafId = null;
        const p = pendingScale;
        pendingScale = null;
        if (p) flushScale(p.width, p.height, p.x, p.y);
      });
    },

    flushFrameResizeScale() {
      if (scaleRafId !== null) {
        cancelAnimationFrame(scaleRafId);
        scaleRafId = null;
      }
      const p = pendingScale;
      pendingScale = null;
      if (p) flushScale(p.width, p.height, p.x, p.y);
    },

    clearFrameResizeSnapshot() {
      // Defensive: drop any still-queued scale tick so a late rAF can't
      // fire after the gesture's authoritative commit (it would
      // early-return against the now-null snapshot anyway).
      cancelScaleRaf();
      lastAppliedFont.clear();
      freeSnapshot = null;
    },

    cancelPendingRaf,
  };
}
