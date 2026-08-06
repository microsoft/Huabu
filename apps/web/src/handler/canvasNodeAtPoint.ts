// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Screen-space node hit-testing for canvas tap gestures.
 *
 * Single source of truth for "which node did this tap land on?", shared
 * by every gesture owner (the pointer-router recognizers, tool overlays,
 * ...) so selection never forks into slightly different answers.
 *
 * It hit-tests React Flow node bounding boxes directly instead of using
 * `document.elementsFromPoint`, which silently skips nodes rendered with
 * `pointer-events: none` — React Flow does exactly that whenever a
 * full-screen tool overlay (e.g. Sketch) is armed, so a finger tapping a
 * node beneath the overlay would otherwise resolve to nothing. Returning
 * the highest-z-index match keeps overlapping nodes correct (e.g. a node
 * nested inside a frame paints above it).
 *
 * DOM-based but framework-light: it relies only on React Flow's stable
 * `.react-flow__node` / `data-id` / inline z-index contract, so callers
 * need no React Flow instance to ask the question.
 */
export function nodeIdAtScreenPoint(
  clientX: number,
  clientY: number,
): string | null {
  const nodeEls = document.querySelectorAll<HTMLElement>('.react-flow__node');
  let bestId: string | null = null;
  let bestZ = -Infinity;
  for (const el of nodeEls) {
    const rect = el.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue;
    }
    const id = el.getAttribute('data-id');
    if (!id) continue;
    const z = Number.parseInt(el.style.zIndex || '0', 10) || 0;
    if (z >= bestZ) {
      bestZ = z;
      bestId = id;
    }
  }
  return bestId;
}
