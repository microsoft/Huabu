import { type Node, type NodeProps } from '@xyflow/react';
import { memo, useMemo } from 'react';

import { NodeWrapper } from '../NodeWrapper';
import { pointsToPath } from './sketchPath';

import type { CanvasSketchNodeData } from '../types';

export type SketchNodeType = Node<CanvasSketchNodeData, 'sketch'>;

export const SketchNode = memo(
  ({ id, data, selected, width, height }: NodeProps<SketchNodeType>) => {
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
    const strokeColor = data.strokeColor ?? 'var(--color-fg-default)';

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="sketch"
        selected={selected}
        resizable={true}
      >
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="pointer-events-none h-full w-full"
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
