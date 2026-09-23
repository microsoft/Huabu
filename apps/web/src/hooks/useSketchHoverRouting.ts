// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import { findSketchHits } from '@/components/Nodes/sketch/sketchHitTest';
import useCanvasStore from '@/store/canvasStore';

import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Screen-space hit slack (in CSS px) when looking for the stroke under
 * the cursor. Touch gets a much larger value because finger taps are
 * imprecise compared to a mouse cursor.
 *
 * Why screen-space? The user's intuition is "I'm aiming at the line
 * with my pointer", which is a screen-space judgement; if we used a
 * fixed flow-space radius the effective on-screen target would shrink
 * as the canvas zooms out, making selection feel arbitrary.
 *
 * The half stroke thickness is added on top inside `findSketchHits`,
 * so a fat brush is still easier to grab than a thin one.
 */
const HOVER_HIT_PX_MOUSE = 6;
const HOVER_HIT_PX_TOUCH = 16;

/**
 * Hover-driven pointer routing for sketch nodes.
 *
 * Sketch nodes have large axis-aligned bounding boxes but visually only
 * occupy the painted stroke pixels. Default hit-testing on the bounding
 * box means a click on the *blank area* of an upper sketch consumes the
 * event, blocking access to anything underneath.
 *
 * This hook installs pointer listeners on the canvas wrapper and runs
 * the same geometric hit test the eraser uses (`findSketchHits`) to
 * determine which sketch's *stroke* the cursor is actually over. The
 * result is published to the DOM as `data-sketch-hover="true"` on the
 * matching `.react-flow__node` element. CSS in `index.css` then:
 *
 *   - keeps every sketch wrapper `pointer-events: none` by default, so
 *     blank-area clicks fall through to whatever is below
 *   - flips only the stroke-hit sketch back to `pointer-events: auto`
 *     plus a subtle hover ring, so the user can grab/select it normally
 *
 * Touch has no hover phase and deliberately never activates a Sketch
 * wrapper. Finger input treats Ink as transparent for direct selection;
 * the viewport recognizer or React Flow handles the ordinary content below.
 */
export function useSketchHoverRouting(
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  rfInstanceRef: React.RefObject<ReactFlowInstance | null>,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let rafId = 0;
    let pendingClientX = 0;
    let pendingClientY = 0;
    let pendingPointerType = 'mouse';
    let lastHoverId: string | null = null;
    let isPointerDown = false;

    const clearHover = () => {
      if (lastHoverId === null) return;
      const prev = wrapper.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(lastHoverId)}"]`,
      );
      if (prev) prev.removeAttribute('data-sketch-hover');
      lastHoverId = null;
    };

    const setHover = (id: string | null) => {
      if (id === lastHoverId) return;
      clearHover();
      if (id === null) return;
      const next = wrapper.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(id)}"]`,
      );
      if (next) {
        next.setAttribute('data-sketch-hover', 'true');
        lastHoverId = id;
      }
    };

    /**
     * Resolve the topmost sketch under (clientX, clientY). Returns the
     * node id or `null`. Hit radius is screen-space px converted to
     * flow-space via the current zoom — keeps the effective target the
     * same size on screen regardless of canvas zoom.
     */
    const hitTest = (
      clientX: number,
      clientY: number,
      pointerType: string,
    ): string | null => {
      const inst = rfInstanceRef.current;
      if (!inst) return null;
      const flow = inst.screenToFlowPosition({ x: clientX, y: clientY });
      const zoom = inst.getZoom();
      const px =
        pointerType === 'touch' ? HOVER_HIT_PX_TOUCH : HOVER_HIT_PX_MOUSE;
      const hitRadius = px / zoom;
      const { topmost } = findSketchHits(flow.x, flow.y, hitRadius);
      return topmost;
    };

    const computeFromPending = () => {
      rafId = 0;
      // While a drag is active, leave the previous hover state alone.
      // Toggling pointer-events on the dragged node could break the drag.
      if (isPointerDown) return;
      setHover(hitTest(pendingClientX, pendingClientY, pendingPointerType));
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) isPointerDown = false;
      pendingClientX = e.clientX;
      pendingClientY = e.clientY;
      pendingPointerType = e.pointerType || 'mouse';
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(computeFromPending);
    };

    const onPointerDown = (e: PointerEvent) => {
      isPointerDown = true;
      pendingClientX = e.clientX;
      pendingClientY = e.clientY;
      pendingPointerType = e.pointerType || 'mouse';

      // Synchronously hit-test on pointerdown. For mouse this is usually
      // a no-op (pointermove already set the hover state), but on touch
      // it's the only way to know what was tapped before React Flow
      // processes the event.
      const id = hitTest(e.clientX, e.clientY, pendingPointerType);
      if (e.pointerType === 'touch') {
        clearHover();
        return;
      }
      setHover(id);
    };

    const onPointerUp = () => {
      isPointerDown = false;
    };
    const onPointerLeave = () => {
      clearHover();
    };

    // Capture phase keeps the geometric hover state current before React
    // Flow's delegated listener processes mouse or pen input.
    wrapper.addEventListener('pointermove', onPointerMove, { passive: true });
    wrapper.addEventListener('pointerdown', onPointerDown, { capture: true });
    wrapper.addEventListener('pointerup', onPointerUp, { capture: true });
    wrapper.addEventListener('pointercancel', onPointerUp, { capture: true });
    wrapper.addEventListener('pointerleave', onPointerLeave, { passive: true });

    // Re-run the hit test whenever sketch geometry changes (new stroke,
    // resize, delete) without waiting for pointer movement, so the
    // highlight stays correct when the cursor is stationary.
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (state.nodes === prev.nodes) return;
      if (rafId !== 0 || pendingClientX === 0) return;
      rafId = requestAnimationFrame(computeFromPending);
    });

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      wrapper.removeEventListener('pointermove', onPointerMove);
      wrapper.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      } as EventListenerOptions);
      wrapper.removeEventListener('pointerup', onPointerUp, { capture: true });
      wrapper.removeEventListener('pointercancel', onPointerUp, {
        capture: true,
      });
      wrapper.removeEventListener('pointerleave', onPointerLeave);
      unsubscribe();
      clearHover();
    };
  }, [enabled, wrapperRef, rfInstanceRef]);
}
