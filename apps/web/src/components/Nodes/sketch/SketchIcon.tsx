// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { memo, useMemo } from 'react';

import { resolveAccent } from '@huabu/shared';

import { DEFAULT_STROKE_COLOR } from './sketchPath';

import type { SketchStroke } from '@huabu/shared';

interface SketchIconProps {
  strokes: SketchStroke[];
  initialSize: { width: number; height: number };
  size?: number;
  strokeWidth?: number;
}

/**
 * Icon-sized preview of a sketch node's strokes.
 *
 * Uses raw input points as `<polyline>` rather than perfect-freehand: at
 * 14×14 the smoothed outline is invisible while costing a lot more
 * (perfect-freehand expands every input point into ~2 outline points and
 * a quadratic bezier path). `vector-effect="non-scaling-stroke"` keeps
 * the stroke pixel-thin regardless of the underlying viewBox.
 *
 * Memoized on the `strokes` reference — the sketch store updates strokes
 * immutably, so re-renders triggered by selection/highlight changes
 * cheaply skip the points-to-string work below.
 */
export const SketchIcon = memo(function SketchIcon({
  strokes,
  initialSize,
  size = 14,
  strokeWidth = 1,
}: SketchIconProps) {
  const lines = useMemo(
    () =>
      strokes.map((s) => ({
        id: s.id,
        points: s.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        stroke: resolveAccent(s.color) ?? s.color ?? DEFAULT_STROKE_COLOR,
      })),
    [strokes],
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${initialSize.width} ${initialSize.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {lines.map((l) => (
        <polyline
          key={l.id}
          points={l.points}
          fill="none"
          stroke={l.stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
});
