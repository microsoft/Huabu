import { useInternalNode, useStore } from '@xyflow/react';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
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

const FLIP_TRANSITION = 'transform 240ms cubic-bezier(0.4, 0, 0.2, 1)';

/**
 * Skip the slide when the mark's anchor moved further than this multiple of the
 * mark size between the two stages. A genuine stage morph during smooth zoom
 * shifts the anchor by at most ~one mark (corner→centre of a near-threshold
 * node); a viewport JUMP (fitView, zoom buttons, wheel/dbl-click zoom) changes
 * zoom AND pan in a single frame, so the old readable-corner and the new
 * collapsed-centre can be hundreds of screen-px apart. FLIP-ing across that
 * teleport makes the mark fly in from far away — so past this bound we snap
 * instead of animating.
 */
const FLIP_MAX_TRAVEL_FACTOR = 3;

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
  const { stage, size, point, collapsedRadius } = useNodeTakeover(nodeId);
  const domNode = useStore((s) => s.domNode);
  const internalNode = useInternalNode(nodeId);
  const setCollapseRadius = useNodeCollapseStore((s) => s.setRadius);
  const rendererEl = useMemo(
    () => domNode?.querySelector('.react-flow__renderer') ?? null,
    [domNode],
  );

  // Publish the collapsed mark radius (canvas space) so edges terminate on the
  // visible mark circle instead of the hidden card footprint. Only changes when
  // the node's collapse state flips (or it resizes), never per zoom frame.
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

  // FLIP the mark on stage change, driven imperatively so it never flashes.
  // We set the mark to its OLD target (translate + scale) and back to rest
  // synchronously inside this layout effect — the first painted frame is
  // already at the old position, so there is no intermediate commit at the new
  // (far) anchor. Only fires on a stage change; plain zoom leaves the mark
  // untouched, so the running animation is never interrupted and re-renders
  // from pan/zoom never reset the transform (JSX never sets it on the flipper).
  const flipperRef = useRef<HTMLDivElement>(null);
  const prev = useRef<{
    stage: string;
    x: number;
    y: number;
    size: number;
  } | null>(null);

  useLayoutEffect(() => {
    const cur = { stage, x: point.x, y: point.y, size };
    const p = prev.current;
    prev.current = cur;
    const el = flipperRef.current;
    if (!el || !p || p.stage === stage) return;

    // The readable badge lives at the card's TOP-LEFT corner; the collapsed
    // marks live at the card's CENTRE. Any transition that crosses the readable
    // boundary therefore relocates the anchor (corner ↔ centre) — animating a
    // slide across it looks like the mark "flying" from the corner to the
    // centre and back. So across that boundary we DON'T translate (the anchor
    // just snaps); we only tween the SCALE, giving a clean grow/shrink in place.
    // Position sliding is kept only for avatar ↔ dot, where both anchors are the
    // centre so there is no travel anyway.
    const crossesReadable = (p.stage === 'readable') !== (stage === 'readable');
    const dx = crossesReadable ? 0 : p.x - cur.x;
    const dy = crossesReadable ? 0 : p.y - cur.y;
    const scale = cur.size > 0 ? p.size / cur.size : 1;

    // Safety net for the collapsed↔collapsed slide: a viewport jump (big zoom +
    // pan in one frame) can still put the two centres far apart; past a sane
    // multiple of the mark size we treat it as a teleport and snap.
    const maxTravel = Math.max(p.size, cur.size) * FLIP_MAX_TRAVEL_FACTOR;
    if (Math.hypot(dx, dy) > maxTravel) {
      el.style.transition = 'none';
      el.style.transform = 'translate(0px, 0px) scale(1)';
      return;
    }

    // Start at the old target with no transition…
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    // …force the browser to register that start state before we animate…
    void el.getBoundingClientRect();
    // …then release to rest, which the transition tweens.
    el.style.transition = FLIP_TRANSITION;
    el.style.transform = 'translate(0px, 0px) scale(1)';
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
      {/* Centering stays constant; the flipper below owns the animated
          transform so React re-renders (pan/zoom) never clobber a FLIP. */}
      <div style={{ transform: 'translate(-50%, -50%)' }}>
        <div
          ref={flipperRef}
          onDoubleClick={onActivate}
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            transformOrigin: 'center',
          }}
        >
          {renderMark(state)}
        </div>
      </div>
    </div>,
    rendererEl,
  );
});
