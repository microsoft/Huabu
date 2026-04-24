import { memo, useMemo } from 'react';

import { pointsToPath } from './annotationPath';

import type { PreviewComponentProps } from '../note/NotePreview';

/**
 * Lightweight preview card for annotation nodes (used in search results, etc.).
 */
export const AnnotationPreview = memo(({ data }: PreviewComponentProps) => {
  const annotationData = data as {
    points?: number[][];
    initialSize?: { width: number; height: number };
    strokeColor?: string;
  };
  const points = annotationData.points ?? [];
  const initialSize = annotationData.initialSize ?? {
    width: 200,
    height: 100,
  };
  const pathD = useMemo(() => pointsToPath(points), [points]);

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <svg
        viewBox={`0 0 ${initialSize.width} ${initialSize.height}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <path d={pathD} fill={annotationData.strokeColor ?? 'currentColor'} />
      </svg>
    </div>
  );
});
