// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { memo, useMemo } from 'react';

import { resolveAccent } from '@huabu/shared';

import {
  pointsToPath,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from './sketchPath';

import type { PreviewComponentProps } from '../note/NotePreview';
import type { SketchStroke } from '@huabu/shared';

/**
 * Lightweight preview card for sketch nodes (used in search results, etc.).
 */
export const SketchPreview = memo(({ data }: PreviewComponentProps) => {
  const sketchData = data as {
    strokes?: SketchStroke[];
    initialSize?: { width: number; height: number };
  };
  const initialSize = sketchData.initialSize ?? {
    width: 200,
    height: 100,
  };

  const renderedStrokes = useMemo(() => {
    const strokes = sketchData.strokes ?? [];
    return strokes.map((s) => ({
      id: s.id,
      d: pointsToPath(s.points, 1, s.size ?? DEFAULT_STROKE_SIZE),
      fill: resolveAccent(s.color) ?? s.color ?? DEFAULT_STROKE_COLOR,
    }));
  }, [sketchData.strokes]);

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <svg
        viewBox={`0 0 ${initialSize.width} ${initialSize.height}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {renderedStrokes.map((s) => (
          <path key={s.id} d={s.d} fill={s.fill} />
        ))}
      </svg>
    </div>
  );
});
