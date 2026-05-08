import { memo, useMemo } from 'react';

import { NodeWrapper } from '../NodeWrapper';
import { pointsToPath } from './annotationPath';

import type { CanvasAnnotationNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type AnnotationNodeType = Node<CanvasAnnotationNodeData, 'annotation'>;

export const AnnotationNode = memo(
  ({ id, data, selected, width, height }: NodeProps<AnnotationNodeType>) => {
    const w = width ?? data.initialSize?.width ?? 1;
    const h = height ?? data.initialSize?.height ?? 1;
    const scaleX = w / (data.initialSize?.width || 1);
    const scaleY = h / (data.initialSize?.height || 1);

    const scaledPoints = useMemo(
      () =>
        (data.points ?? []).map((pt: number[]) => [
          pt[0] * scaleX,
          pt[1] * scaleY,
          pt[2],
        ]),
      [data.points, scaleX, scaleY],
    );

    const pathD = useMemo(() => pointsToPath(scaledPoints), [scaledPoints]);
    const strokeColor = data.strokeColor ?? '#000000';
    // Executed strokes are dimmed but kept on the canvas so the user can
    // still see the gesture they drew.
    const isExecuted = data.executed ?? false;

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="annotation"
        selected={selected}
        resizable={true}
      >
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="pointer-events-none h-full w-full"
          style={isExecuted ? { opacity: 0.25 } : undefined}
        >
          <path
            d={pathD}
            fill={strokeColor}
            className="pointer-events-auto cursor-pointer"
          />
        </svg>
      </NodeWrapper>
    );
  },
);
