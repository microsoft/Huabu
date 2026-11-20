// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useViewport } from '@xyflow/react';

import { useCanvasPresenceStore } from '@/store/canvasPresence/canvasPresenceStore';

import { presenceColor } from './presencePaint';
import { usePresenceLabel } from './usePresenceLabel';

/**
 * The other pages' pointers. Positions arrive in flow coordinates, so each
 * marker lands on the same canvas point whatever this page's pan and zoom.
 * Subscribes to `pointers` itself: a pointer tick re-renders only this.
 */
export function RemoteCursors() {
  const pointers = useCanvasPresenceStore((state) => state.pointers);
  const pages = useCanvasPresenceStore((state) => state.pages);
  const { x: viewportX, y: viewportY, zoom } = useViewport();
  const labelOf = usePresenceLabel();
  // A pointer without its page has no colour or label to draw with.
  const entries = Object.entries(pointers).flatMap(([pageId, pointer]) => {
    const page = pages[pageId];
    return page ? [{ pageId, pointer, page }] : [];
  });
  if (entries.length === 0) return null;
  return (
    <div
      aria-hidden
      data-canvas-grounding-exclude
      data-presence-cursors
      className="pointer-events-none absolute top-0 left-0 z-999"
      style={{ transform: `translate(${viewportX}px, ${viewportY}px)` }}
    >
      {entries.map(({ pageId, pointer, page }) => {
        const color = presenceColor(page.colorIndex);
        return (
          <div
            key={pageId}
            data-presence-cursor={pageId}
            data-presence-color={page.colorIndex}
            className="absolute top-0 left-0 motion-safe:transition-transform motion-safe:duration-100 motion-safe:ease-linear"
            style={{
              transform: `translate(${pointer.x * zoom}px, ${pointer.y * zoom}px)`,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              className="block"
              style={{ color }}
            >
              <path
                d="M1.5 1.5 L1.5 12.5 L4.8 9.6 L7 14.5 L9 13.6 L6.8 8.8 L11 8.5 Z"
                fill="currentColor"
                stroke="var(--color-surface)"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
            <span
              data-presence-label
              className="text-fg-inverse absolute top-3.5 left-3 rounded-sm px-1 text-[10px] leading-4 font-medium whitespace-nowrap"
              style={{ backgroundColor: color }}
            >
              {labelOf(page)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
