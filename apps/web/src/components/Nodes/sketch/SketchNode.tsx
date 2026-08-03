import { Sparkles } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@sediment/shared';
import { getSketchRenderedSize } from '@sediment/shared/canvas-engine';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { MissingFileBanner } from '@/components/Nodes/MissingFileBanner';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
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
    const { t } = useTranslation();
    // The explicit `style` size is the store's synchronous source of truth for
    // sizing: `SET_NODE_GEOMETRY` writes it, and a live resize mirrors onto it
    // in the same `set`. The `width`/`height` props are the *measured* size,
    // which lags a frame behind a programmatic resize. Reading the measured
    // size here made a stroke-merge that grows the bbox briefly render every
    // stroke at `oldMeasured / newInitialSize` ≠ 1 — a one-frame jitter of the
    // whole sketch. Preferring `style` keeps the render scale in lockstep with
    // the merge's geometry + initialSize update.
    const storeNode = useCanvasStore((s) => s.nodes.find((n) => n.id === id));
    const renderedSize = storeNode
      ? getSketchRenderedSize(storeNode)
      : { width: 0, height: 0 };
    const w = renderedSize.width || width || data.initialSize?.width || 1;
    const h = renderedSize.height || height || data.initialSize?.height || 1;
    const scaleX = w / (data.initialSize?.width || 1);
    const scaleY = h / (data.initialSize?.height || 1);
    const isContentMissing = data.contentMissing === true;

    const requestSketchRecognition = useIntentStore(
      (s) => s.requestSketchRecognition,
    );
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const beginNodeDataGesture = useCanvasStore((s) => s.beginNodeDataGesture);
    const endNodeDataGesture = useCanvasStore((s) => s.endNodeDataGesture);
    const erasedStrokeIds = useGesturePreviewStore(
      (s) => s.sketchErasePreview[id],
    );
    const erasedStrokeIdSet = useMemo(
      () => new Set(erasedStrokeIds),
      [erasedStrokeIds],
    );

    const selectedStrokeIds = useGesturePreviewStore(
      (s) => s.sketchStrokeSelection[id],
    );
    const selectedStrokeIdSet = useMemo(
      () => new Set(selectedStrokeIds),
      [selectedStrokeIds],
    );
    // Transient hover highlight (e.g. hovering a chat message's stroke
    // chip). Only strokes still present on this node paint — erased
    // strokes / deleted nodes simply never match, so no cleanup needed.
    const highlightStrokeIds = useGesturePreviewStore(
      (s) => s.sketchStrokeHighlight[id],
    );
    const highlightStrokeIdSet = useMemo(
      () => new Set(highlightStrokeIds),
      [highlightStrokeIds],
    );
    // Live translate applied to selected strokes while a move drag is in
    // progress (flow-space; 1 SVG unit = 1 flow unit within the node).
    const movePreview = useGesturePreviewStore(
      (s) => s.sketchStrokeMovePreview,
    );
    // When this node is carried by a dragged ancestor (e.g. a framed sketch
    // lassoed together with its frame), the ancestor's drag already moves
    // the whole node by the group delta. Applying the stroke preview on top
    // would translate the selected strokes a second time, sliding them out
    // of the frame — so suppress the preview for this node in that case.
    const carriedNodeIds = useGesturePreviewStore(
      (s) => s.sketchStrokeMoveCarriedNodeIds,
    );
    const isCarried = carriedNodeIds.includes(id);

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
        onSizeDragStart={beginNodeDataGesture}
        onSizeDragEnd={endNodeDataGesture}
      />
    );

    const sketchActions = (
      <FloatingToolbar.ActionButton
        title={t('node.applySketch')}
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
        toolbar={isContentMissing ? undefined : sketchToolbar}
        actions={isContentMissing ? undefined : sketchActions}
        allowOverflow
      >
        {isContentMissing ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            className="h-full w-full"
            overflow="visible"
          >
            {/*
            Hit-testing: the wrapper `.react-flow__node-sketch` is set to
            `pointer-events: none` in `index.css` so blank areas of the
            stroke's bounding box drill through to nodes beneath. Each
            <path> uses the SVG default `pointer-events: visiblePainted`,
            which only registers hits on actual rendered fill \u2014 i.e. the
            painted stroke shape itself. No Tailwind override needed.
          */}
            {strokes.map((s) => {
              const isSelected = selectedStrokeIdSet.has(s.id);
              const isHighlighted =
                !isSelected && highlightStrokeIdSet.has(s.id);
              return (
                <g
                  key={s.id}
                  visibility={
                    erasedStrokeIdSet.has(s.id) ? 'hidden' : undefined
                  }
                  transform={
                    movePreview && isSelected && !isCarried
                      ? `translate(${movePreview.dx} ${movePreview.dy})`
                      : undefined
                  }
                  style={
                    isSelected || isHighlighted
                      ? { filter: 'drop-shadow(0 0 3px var(--color-info))' }
                      : undefined
                  }
                >
                  <StrokePath stroke={s} scaleX={scaleX} scaleY={scaleY} />
                </g>
              );
            })}
          </svg>
        )}
      </NodeWrapper>
    );
  },
);
