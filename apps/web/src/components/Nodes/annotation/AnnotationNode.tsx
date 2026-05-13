import { Sparkles } from 'lucide-react';
import { memo, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useIntentStore } from '@/store/intentStore';

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

    const requestSketchRecognition = useIntentStore(
      (s) => s.requestSketchRecognition,
    );

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

    const sketchToolbar = (
      <FloatingToolbar.ActionButton
        title="Apply Sketch (interpret stroke with AI)"
        onClick={(e) => {
          e.stopPropagation();
          requestSketchRecognition([id]);
        }}
      >
        <Sparkles />
      </FloatingToolbar.ActionButton>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="annotation"
        selected={selected}
        resizable={true}
        toolbar={sketchToolbar}
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
