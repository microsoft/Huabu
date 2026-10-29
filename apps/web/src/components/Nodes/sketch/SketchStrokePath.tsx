// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { memo, useMemo } from 'react';

import { resolveAccentCss } from '@/utils/accentColor';

import { pointsToPath } from './sketchPath';

import type { SketchStroke } from '@huabu/shared';

type StrokeEmphasis = 'selected' | 'reference';

/** Render one Ink stroke with an optional screen-stable semantic outline. */
export const SketchStrokePath = memo(function SketchStrokePath({
  stroke,
  scaleX,
  scaleY,
  emphasis,
}: {
  stroke: SketchStroke;
  scaleX: number;
  scaleY: number;
  emphasis?: StrokeEmphasis;
}) {
  const scaledPoints = useMemo(
    () =>
      stroke.points.map((point) => [
        point[0] * scaleX,
        point[1] * scaleY,
        point[2],
      ]),
    [stroke.points, scaleX, scaleY],
  );
  const pathD = useMemo(
    () => pointsToPath(scaledPoints, 1, stroke.size),
    [scaledPoints, stroke.size],
  );
  const resolvedColor = resolveAccentCss(stroke.color) ?? stroke.color;

  return (
    <>
      {emphasis && (
        <path
          data-sketch-stroke-emphasis={emphasis}
          data-canvas-grounding-exclude
          d={pathD}
          fill="none"
          stroke="var(--color-info)"
          strokeWidth={2}
          strokeOpacity={`var(--sketch-${emphasis}-opacity)`}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          style={{
            filter: 'drop-shadow(0 0 2px var(--color-info-light))',
          }}
        />
      )}
      <path d={pathD} fill={resolvedColor} className="cursor-pointer" />
    </>
  );
});
