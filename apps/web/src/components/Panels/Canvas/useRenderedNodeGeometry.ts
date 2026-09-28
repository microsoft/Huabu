// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export interface RenderedNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  borderLeft: number;
  borderTop: number;
}

export interface RenderedNodeGeometryState {
  geometry: RenderedNodeGeometry | null;
  gestureResizing: boolean;
}

function sameGeometry(
  current: RenderedNodeGeometry | null,
  next: RenderedNodeGeometry,
): boolean {
  return (
    current?.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height &&
    current.radius === next.radius &&
    current.borderLeft === next.borderLeft &&
    current.borderTop === next.borderTop
  );
}

/** Observe the node border box in the screen-space coordinate system of its HUD portal. */
export function useRenderedNodeGeometry(
  nodeId: string,
  domNode: HTMLDivElement | null,
  activelyResizing: boolean,
  transform: {
    nodeX: number;
    nodeY: number;
    nodeWidth: number;
    nodeHeight: number;
    viewportX: number;
    viewportY: number;
    zoom: number;
  },
  enabled = true,
): RenderedNodeGeometryState {
  const [geometry, setGeometry] = useState<RenderedNodeGeometry | null>(null);
  const [gestureResizing, setGestureResizing] = useState(false);
  const measureRef = useRef<((flush: boolean) => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const body = document.body;
    const update = () =>
      setGestureResizing(body.classList.contains('node-resize-active'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(body, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled || !domNode || typeof ResizeObserver === 'undefined') {
      setGeometry(null);
      return;
    }
    const element = Array.from(
      domNode.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'),
    ).find((candidate) => candidate.dataset.id === nodeId);
    if (!element) return;

    const update = (flush: boolean) => {
      const surface = element.querySelector<HTMLElement>('[data-node-surface]');
      if (!surface) return;
      const containerRect = domNode.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const style = getComputedStyle(surface);
      const scale =
        surface.offsetWidth > 0 ? surfaceRect.width / surface.offsetWidth : 1;
      const next = {
        x: surfaceRect.left - containerRect.left,
        y: surfaceRect.top - containerRect.top,
        width: surfaceRect.width,
        height: surfaceRect.height,
        radius: Number.parseFloat(style.borderTopLeftRadius) * scale,
        borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
        borderTop: Number.parseFloat(style.borderTopWidth) || 0,
      };
      const commit = () =>
        setGeometry((current) =>
          sameGeometry(current, next) ? current : next,
        );
      if (flush) flushSync(commit);
      else commit();
    };
    measureRef.current = update;
    update(false);
    const observer = new ResizeObserver(() => update(true));
    observer.observe(element);
    const mutationObserver = new MutationObserver(() => update(true));
    mutationObserver.observe(element, { childList: true, subtree: true });
    const surface = element.querySelector<HTMLElement>('[data-node-surface]');
    if (surface) {
      mutationObserver.observe(surface, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-presentation'],
      });
    }
    return () => {
      measureRef.current = null;
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [domNode, nodeId, enabled]);

  useLayoutEffect(() => {
    measureRef.current?.(false);
  }, [
    transform.nodeX,
    transform.nodeY,
    transform.nodeWidth,
    transform.nodeHeight,
    transform.viewportX,
    transform.viewportY,
    transform.zoom,
  ]);

  useLayoutEffect(() => {
    if (!enabled || (!activelyResizing && !gestureResizing)) return;
    let frame = 0;
    const update = () => {
      measureRef.current?.(true);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [activelyResizing, gestureResizing, enabled]);

  return { geometry: enabled ? geometry : null, gestureResizing };
}
