// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useViewport } from '@xyflow/react';
import { memo, useId } from 'react';

import { CANVAS_GRID_DOT_RADIUS, canvasGridForZoom } from './canvasGridPolicy';

/** Decorative, world-anchored dots with constant screen size and bounded density. */
export const CanvasGrid = memo(function CanvasGrid() {
  const { x, y, zoom } = useViewport();
  const id = `canvas-grid-${useId()}`;
  const { spacing, detailOpacity } = canvasGridForZoom(zoom);
  const radius = CANVAS_GRID_DOT_RADIUS;
  const period = spacing * 2;

  return (
    <svg
      data-testid="canvas-grid"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: -1 }}
    >
      <defs>
        <pattern
          id={id}
          x={(x % period) - radius}
          y={(y % period) - radius}
          width={period}
          height={period}
          patternUnits="userSpaceOnUse"
        >
          {/* Four disjoint sites avoid darkening the persistent coarse dots. */}
          <g fill="var(--canvas-grid)">
            <circle cx={radius} cy={radius} r={radius} />
            <g opacity={detailOpacity}>
              <circle cx={radius + spacing} cy={radius} r={radius} />
              <circle cx={radius} cy={radius + spacing} r={radius} />
              <circle cx={radius + spacing} cy={radius + spacing} r={radius} />
            </g>
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
});
