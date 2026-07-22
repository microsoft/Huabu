import { useInternalNode, useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useNodeTakeover } from '@/hooks/useNodeTakeover';

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

interface FlipState {
  dx: number;
  dy: number;
  scale: number;
}

const NO_FLIP: FlipState = { dx: 0, dy: 0, scale: 1 };

/**
 * `NodeTakeoverLayer` — the screen-space overlay that realises the discrete
 * three-stage zoom takeover for the question node.
 *
 *   - It positions the node-supplied mark at its stage target (top-left corner
 *     in `readable`, node centre in `avatar`/`dot`). The base position tracks
 *     pan/zoom immediately (no transition, so it never smears).
 *   - When the STAGE changes it runs a one-shot FLIP animation (translate +
 *     scale from the old target/size to the new) so the mark slides + resizes
 *     smoothly; at rest it is always at a crisp stage.
 *   - It publishes a binary `data-lod-body` attribute on the node root so the
 *     card fades fully out (crisp, never a resting half-opacity) in the
 *     non-readable stages; the mark lives in this separate portal so it is not
 *     faded with the card.
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
  const { stage, size, point } = useNodeTakeover(nodeId);
  const domNode = useStore((s) => s.domNode);
  const internalNode = useInternalNode(nodeId);
  const rendererEl = useMemo(
    () => domNode?.querySelector('.react-flow__renderer') ?? null,
    [domNode],
  );

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

  // FLIP the mark on stage change: capture the delta from the old target
  // point/size, then animate it back to zero so the mark slides + resizes into
  // its new stage. Only fires on a stage change, so plain zoom never animates.
  const prev = useRef<{
    stage: string;
    x: number;
    y: number;
    size: number;
  } | null>(null);
  const [flip, setFlip] = useState<FlipState>(NO_FLIP);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    const cur = { stage, x: point.x, y: point.y, size };
    const p = prev.current;
    prev.current = cur;
    if (!p || p.stage === stage) return;

    const dx = p.x - cur.x;
    const dy = p.y - cur.y;
    const scale = cur.size > 0 ? p.size / cur.size : 1;
    setFlip({ dx, dy, scale });
    setPlaying(false);

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setFlip(NO_FLIP);
      setPlaying(true);
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [stage, point.x, point.y, size]);

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
      <div
        onDoubleClick={onActivate}
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          transformOrigin: 'center',
          transform: `translate(-50%, -50%) translate(${flip.dx}px, ${flip.dy}px) scale(${flip.scale})`,
          transition: playing
            ? 'transform 240ms cubic-bezier(0.4, 0, 0.2, 1)'
            : 'none',
        }}
      >
        {renderMark(state)}
      </div>
    </div>,
    rendererEl,
  );
});
