import { useInternalNode, useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

import { useNodeTakeover } from '@/hooks/useNodeTakeover';
import { useNodeCollapseStore } from '@/store/nodeCollapseStore';

import type { TakeoverState } from '@/config/nodeTakeover';
import type React from 'react';

export interface NodeTakeoverLayerProps {
  nodeId: string;
  /** The node draws its own mark (size/detail/chrome/click are the node's). */
  renderMark: (state: TakeoverState) => React.ReactNode;
  /** Semantics-free double-click passthrough wired by NodeWrapper to the node's activate handler. */
  onActivate?: React.MouseEventHandler;
  /** The node's outer shell element; the engine writes the card-fade attribute here. */
  nodeRootRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * `NodeTakeoverLayer` — the screen-space overlay that realises the zoom
 * takeover for the question node.
 *
 *   - It positions the node-supplied mark at its CONTINUOUS target: the mark's
 *     size and screen point come from {@link useNodeTakeover}, which interpolates
 *     them by zoom (corner+badge → centre+mark). Because that geometry is exact
 *     every frame, the overlay simply re-renders at the new left/top/size as the
 *     canvas zooms — the badge glides and resizes smoothly with the gesture,
 *     with no discrete stage swap and no one-shot animation to feel abrupt.
 *   - It publishes a binary `data-lod-body` attribute on the node root so the
 *     card body fades out once the takeover band starts; the mark lives in this
 *     separate portal so it is not faded with the card.
 *
 * It has NO interaction vocabulary: the mark owns its own click + gating; the
 * engine only forwards a double-click. Memoised + self-subscribed, so
 * continuous zoom re-renders only this small overlay, never the node body.
 */
export const NodeTakeoverLayer = memo(function NodeTakeoverLayer({
  nodeId,
  renderMark,
  onActivate,
  nodeRootRef,
}: NodeTakeoverLayerProps) {
  const { stage, size, point, collapsedRadius } = useNodeTakeover(nodeId);
  const domNode = useStore((s) => s.domNode);
  const internalNode = useInternalNode(nodeId);
  const setCollapseRadius = useNodeCollapseStore((s) => s.setRadius);
  const rendererEl = useMemo(
    () => domNode?.querySelector('.react-flow__renderer') ?? null,
    [domNode],
  );

  // Publish the collapsed mark radius (canvas space) so edges terminate on the
  // visible mark circle instead of the hidden card footprint.
  useLayoutEffect(() => {
    setCollapseRadius(nodeId, collapsedRadius);
    return () => setCollapseRadius(nodeId, null);
  }, [nodeId, collapsedRadius, setCollapseRadius]);

  // Binary card fade — written here (and only here) so NodeWrapper and the card
  // markup compute nothing.
  useLayoutEffect(() => {
    const el = nodeRootRef.current;
    if (!el) return;
    el.setAttribute(
      'data-lod-body',
      stage === 'readable' ? 'visible' : 'hidden',
    );
    return () => el.removeAttribute('data-lod-body');
  }, [stage, nodeRootRef]);

  if (!rendererEl || !internalNode) return null;

  const state: TakeoverState = { stage, size };

  return createPortal(
    <div
      style={{
        position: 'absolute',
        left: point.x,
        top: point.y,
        pointerEvents: 'none',
        zIndex: 1000,
      }}
    >
      {/* Centre the mark on the interpolated point; the mark's own size (from
          state.size) shrinks it continuously as the node collapses. */}
      <div
        onDoubleClick={onActivate}
        style={{
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'auto',
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
