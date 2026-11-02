// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { DragPayload } from './dragDrop';

type Point = { x: number; y: number };
type DropHandler = (payload: DragPayload, point: Point) => void;

const targets = new WeakMap<Element, DropHandler>();

export function registerCanvasDropTarget(
  element: Element,
  handler: DropHandler,
): () => void {
  targets.set(element, handler);
  return () => targets.delete(element);
}

function findTarget(point: Point): DropHandler | undefined {
  let hit = document.elementFromPoint(point.x, point.y);
  if (hit?.closest('[data-sketch-overlay]')) {
    hit =
      document
        .elementsFromPoint(point.x, point.y)
        .find((element) => !element.closest('[data-sketch-overlay]')) ?? null;
  }
  // Touch excerpts land only on empty canvas, never through a node, toolbar,
  // or preview panel. Desktop's native drop targets remain independent.
  if (!hit?.classList.contains('react-flow__pane')) return undefined;
  const canvas = hit.closest('[data-canvas-root]');
  return canvas ? targets.get(canvas) : undefined;
}

export function canDropOnCanvas(point: Point): boolean {
  return !!findTarget(point);
}

export function dropOnCanvas(payload: DragPayload, point: Point): void {
  findTarget(point)?.(payload, point);
}
