import { resolveAccent } from '@sediment/shared';
import { Sparkles } from 'lucide-react';
import { memo, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import useCanvasStore from '@/store/canvasStore';
import { useIntentStore } from '@/store/intentStore';

import { NodeWrapper } from '../NodeWrapper';
import { SketchControls } from './SketchControls';
import {
  pointsToPath,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from './sketchPath';

import type { CanvasSketchNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type SketchNodeType = Node<CanvasSketchNodeData, 'sketch'>;

export const SketchNode = memo(
  ({ id, data, selected, width, height }: NodeProps<SketchNodeType>) => {
    const w = width ?? data.initialSize?.width ?? 1;
    const h = height ?? data.initialSize?.height ?? 1;
    const scaleX = w / (data.initialSize?.width || 1);
    const scaleY = h / (data.initialSize?.height || 1);

    const requestSketchRecognition = useIntentStore(
      (s) => s.requestSketchRecognition,
    );
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);

    const scaledPoints = useMemo(
      () =>
        (data.points ?? []).map((pt: number[]) => [
          pt[0] * scaleX,
          pt[1] * scaleY,
          pt[2],
        ]),
      [data.points, scaleX, scaleY],
    );

    const strokeColor = data.strokeColor ?? DEFAULT_STROKE_COLOR;
    const strokeSize = data.strokeSize ?? DEFAULT_STROKE_SIZE;
    // Resolve the stored palette token to a CSS color for the SVG fill.
    // `resolveAccent` passes legacy hex strings through unchanged.
    const resolvedColor = resolveAccent(strokeColor) ?? strokeColor;

    const pathD = useMemo(
      () => pointsToPath(scaledPoints, 1, strokeSize),
      [scaledPoints, strokeSize],
    );

    const sketchToolbar = (
      <>
        <SketchControls
          color={strokeColor}
          size={strokeSize}
          onColorChange={(color) => updateNodeData(id, { strokeColor: color })}
          onSizeChange={(size) => updateNodeData(id, { strokeSize: size })}
        />
        <FloatingToolbar.Divider />
        <FloatingToolbar.ActionButton
          title="Apply Sketch (interpret stroke with AI)"
          onClick={(e) => {
            e.stopPropagation();
            requestSketchRecognition([id]);
          }}
        >
          <Sparkles />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="sketch"
        selected={selected}
        resizable={true}
        toolbar={sketchToolbar}
        allowOverflow
      >
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="pointer-events-none h-full w-full"
        >
          <path
            d={pathD}
            fill={resolvedColor}
            className="pointer-events-auto cursor-pointer"
          />
        </svg>
      </NodeWrapper>
    );
  },
);
