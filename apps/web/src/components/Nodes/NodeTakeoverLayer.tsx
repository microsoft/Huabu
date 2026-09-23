// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode, useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { QUESTION_TAKEOVER_AVATAR_RATIO } from '@/config/nodeTakeover';
import { useNodeTakeover } from '@/hooks/useNodeTakeover';
import { useTakeoverMarkDrag } from '@/hooks/useTakeoverMarkDrag';
import { useNodeCollapseStore } from '@/store/nodeCollapseStore';

import type { TakeoverState } from '@/config/nodeTakeover';
import type React from 'react';

export interface NodeTakeoverLayerProps {
  nodeId: string;
  fontSize?: number;
  forceCollapsed?: boolean;
  /** The node draws its own mark (size/detail/chrome/click are the node's). */
  renderMark: (state: TakeoverState) => React.ReactNode;
  /** Semantics-free double-click passthrough wired by NodeWrapper to the node's activate handler. */
  onActivate?: React.MouseEventHandler;
  /** The node's outer shell element; the engine writes the card-fade attribute here. */
  nodeRoot: HTMLDivElement | null;
  /** Hide portal chrome under a Frame region without changing handle anchors. */
  suppressed?: boolean;
}

/**
 * `NodeTakeoverLayer` — the screen-space overlay that realises the zoom
 * takeover for the question node.
 *
 *   - It positions the node-supplied mark at the size + screen point supplied by
 *     {@link useNodeTakeover}: authored geometry scales uniformly with zoom,
 *     centered on the retained node footprint throughout the handoff.
 *   - It publishes a binary `data-lod-body` attribute on the node root so the
 *     card body fades out once the takeover band starts; the mark lives in this
 *     separate portal so it is not faded with the card.
 *
 * It has ONE interaction concern of its own — pointer-drag of the node —
 * because moving the collapsed node needs the React Flow instance + store
 * that live here, not in the presentational mark (see `useTakeoverMarkDrag`).
 * The mark still owns its own click + gating; the engine only forwards a
 * double-click. Memoised + self-subscribed, so continuous zoom re-renders
 * only this small overlay, never the node body.
 */
export const NodeTakeoverLayer = memo(function NodeTakeoverLayer({
  nodeId,
  fontSize,
  forceCollapsed,
  renderMark,
  onActivate,
  nodeRoot,
  suppressed = false,
}: NodeTakeoverLayerProps) {
  const [boundsRatio, setBoundsRatio] = useState<number>(
    QUESTION_TAKEOVER_AVATAR_RATIO,
  );
  const {
    stage,
    size,
    point,
    collapsedCenter,
    collapsedRadius,
    glideProgress,
    collapsedFootprint,
  } = useNodeTakeover(nodeId, boundsRatio, fontSize, forceCollapsed);
  const domNode = useStore((s) => s.domNode);
  const internalNode = useInternalNode(nodeId);
  const markDrag = useTakeoverMarkDrag(nodeId);
  const setMark = useNodeCollapseStore((s) => s.setMark);
  const rendererEl = useMemo(
    () => domNode?.querySelector('.react-flow__renderer') ?? null,
    [domNode],
  );

  // Publish the collapsed mark's live centre + radius + footprint (canvas space)
  // so interaction chrome can ease onto the mark as it glides in. Depend on
  // primitives so the effect only re-runs when the geometry actually changes,
  // and clear on unmount in a separate effect so a per-frame update never
  // transiently nulls the mark (which would flicker the chrome).
  const markCx = collapsedCenter?.x ?? null;
  const markCy = collapsedCenter?.y ?? null;
  const footX = collapsedFootprint?.x ?? null;
  const footY = collapsedFootprint?.y ?? null;
  const footW = collapsedFootprint?.width ?? null;
  const footH = collapsedFootprint?.height ?? null;
  useLayoutEffect(() => {
    if (
      markCx !== null &&
      markCy !== null &&
      collapsedRadius !== null &&
      footX !== null &&
      footY !== null &&
      footW !== null &&
      footH !== null
    ) {
      setMark(nodeId, {
        cx: markCx,
        cy: markCy,
        radius: collapsedRadius,
        progress: glideProgress,
        footprint: { x: footX, y: footY, width: footW, height: footH },
      });
    } else {
      setMark(nodeId, null);
    }
  }, [
    nodeId,
    markCx,
    markCy,
    collapsedRadius,
    glideProgress,
    footX,
    footY,
    footW,
    footH,
    setMark,
  ]);
  useLayoutEffect(() => () => setMark(nodeId, null), [nodeId, setMark]);

  // Binary card fade — written here (and only here) so NodeWrapper and the card
  // markup compute nothing.
  useLayoutEffect(() => {
    const el = nodeRoot;
    if (!el) return;
    el.setAttribute(
      'data-lod-body',
      stage === 'readable' ? 'visible' : 'hidden',
    );
    el.style.setProperty('--takeover-body-opacity', String(1 - glideProgress));
    return () => {
      el.removeAttribute('data-lod-body');
      el.style.removeProperty('--takeover-body-opacity');
    };
  }, [stage, glideProgress, nodeRoot]);

  if (!rendererEl || !internalNode || suppressed) return null;

  const state: TakeoverState = {
    stage,
    size,
    progress: glideProgress,
    onBoundsChange: setBoundsRatio,
  };

  return createPortal(
    <div
      data-takeover-node={nodeId}
      aria-hidden={glideProgress === 0 || undefined}
      inert={glideProgress === 0}
      style={{
        position: 'absolute',
        left: point.x,
        top: point.y,
        pointerEvents: 'none',
        zIndex: 1000,
        opacity: glideProgress,
        visibility: glideProgress === 0 ? 'hidden' : 'visible',
      }}
    >
      {/* Center the visible ring/bubble bounds on the retained footprint. */}
      <div
        // `nopan` opts this portal out of React Flow's zoom/pan filter
        // (`event.target.closest('.nopan')`). The portal is a direct child of
        // `.react-flow__renderer`, the element d3-zoom binds `dblclick.zoom`
        // to, so without this a double-click on the mark would zoom the canvas
        // — a React `stopPropagation` runs at the React root, too late to beat
        // that native handler.
        className="nopan"
        onDoubleClick={onActivate}
        onPointerDown={markDrag.onPointerDown}
        onPointerMove={markDrag.onPointerMove}
        onPointerUp={markDrag.onPointerUp}
        onPointerCancel={markDrag.onPointerCancel}
        onClickCapture={markDrag.onClickCapture}
        style={{
          transform: 'translate(-50%, -50%)',
          pointerEvents: glideProgress > 0 ? 'auto' : 'none',
          display: 'flex',
          transformOrigin: 'center',
        }}
      >
        {renderMark(state)}
      </div>
    </div>,
    rendererEl,
  );
});
