import { Sparkles } from 'lucide-react';
import { memo, useMemo } from 'react';

import { resolveAccent } from '@sediment/shared';

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
import type { SketchStroke } from '@sediment/shared';
import type { Node, NodeProps } from '@xyflow/react';

export type SketchNodeType = Node<CanvasSketchNodeData, 'sketch'>;

/**
 * Render a single stroke as an SVG `<path>`. Pulled out so the parent
 * node can map across `data.strokes` without re-running the (relatively
 * expensive) `pointsToPath` for unchanged strokes when the user adds a
 * new one.
 */
const StrokePath = memo(function StrokePath({
  stroke,
  scaleX,
  scaleY,
}: {
  stroke: SketchStroke;
  scaleX: number;
  scaleY: number;
}) {
  const scaledPoints = useMemo(
    () => stroke.points.map((pt) => [pt[0] * scaleX, pt[1] * scaleY, pt[2]]),
    [stroke.points, scaleX, scaleY],
  );
  const pathD = useMemo(
    () => pointsToPath(scaledPoints, 1, stroke.size),
    [scaledPoints, stroke.size],
  );
  // Resolve the stored palette token to a CSS color for the SVG fill.
  // `resolveAccent` passes legacy hex strings through unchanged.
  const resolvedColor = resolveAccent(stroke.color) ?? stroke.color;
  return <path d={pathD} fill={resolvedColor} className="cursor-pointer" />;
});

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

    const strokes = data.strokes ?? [];
    // Toolbar swatches show the most recently drawn stroke's color/size
    // (last entry in the array), since that is the user's most recent
    // pick on this node. Falls back to the package defaults for an empty
    // node (shouldn't normally exist; defensive).
    const lastStroke = strokes[strokes.length - 1];
    const toolbarColor = lastStroke?.color ?? DEFAULT_STROKE_COLOR;
    const toolbarSize = lastStroke?.size ?? DEFAULT_STROKE_SIZE;

    const sketchToolbar = (
      <SketchControls
        color={toolbarColor}
        size={toolbarSize}
        onColorChange={(color) =>
          updateNodeData(id, {
            strokes: strokes.map((s) => ({ ...s, color })),
          })
        }
        onSizeChange={(size) =>
          updateNodeData(id, {
            strokes: strokes.map((s) => ({ ...s, size })),
          })
        }
      />
    );

    const sketchActions = (
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
        type="sketch"
        selected={selected}
        resizable={true}
        toolbar={sketchToolbar}
        actions={sketchActions}
        allowOverflow
      >
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="h-full w-full"
        >
          {/*
            Hit-testing: the wrapper `.react-flow__node-sketch` is set to
            `pointer-events: none` in `index.css` so blank areas of the
            stroke's bounding box drill through to nodes beneath. Each
            <path> uses the SVG default `pointer-events: visiblePainted`,
            which only registers hits on actual rendered fill \u2014 i.e. the
            painted stroke shape itself. No Tailwind override needed.
          */}
          {strokes.map((s) => (
            <StrokePath key={s.id} stroke={s} scaleX={scaleX} scaleY={scaleY} />
          ))}
        </svg>
      </NodeWrapper>
    );
  },
);
