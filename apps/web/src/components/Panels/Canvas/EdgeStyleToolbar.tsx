import { useStore, useViewport } from '@xyflow/react';
import { useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

import { COLOR_PALETTE } from '@/config/colors';
import useCanvasStore from '@/store/canvasStore';

import { FloatingToolbar } from '../../Common/FloatingToolbar';

import type { SelectOption } from '../../Common/Select';
import type { CanvasEdgeId } from '@sediment/shared';
import type {
  EdgeLineType,
  EdgeLineStyle,
  EdgeDirection,
  EdgeStyle,
  EdgeStrokeWidth,
} from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

// ---- Icon helpers ----

function LineStyleIcon({ dash }: { dash?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <line
        x1="2"
        y1="8"
        x2="14"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

function ArrowIcon({ left, right }: { left?: boolean; right?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <line
        x1={left ? '3.5' : '2'}
        y1="8"
        x2={right ? '12.5' : '14'}
        y2="8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {left && (
        <polyline
          points="5.5,6 3,8 5.5,10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {right && (
        <polyline
          points="10.5,6 13,8 10.5,10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function StrokeWidthIcon({ width }: { width: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <line
        x1="2"
        y1="8"
        x2="14"
        y2="8"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
      />
    </svg>
  );
}

function LineTypeIcon({ type }: { type: EdgeLineType }) {
  const d =
    type === 'bezier'
      ? 'M2 14 C2 3, 14 14, 14 3'
      : type === 'step'
        ? 'M2 12 H8 V4 H14'
        : 'M2 12 L14 4';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---- Select options ----

const LINE_TYPE_OPTIONS: SelectOption<EdgeLineType>[] = [
  { value: 'bezier', label: 'Bezier', icon: <LineTypeIcon type="bezier" /> },
  {
    value: 'straight',
    label: 'Straight',
    icon: <LineTypeIcon type="straight" />,
  },
  { value: 'step', label: 'Step', icon: <LineTypeIcon type="step" /> },
];

const LINE_STYLE_OPTIONS: SelectOption<EdgeLineStyle>[] = [
  { value: 'solid', label: 'Solid', icon: <LineStyleIcon /> },
  { value: 'dashed', label: 'Dashed', icon: <LineStyleIcon dash="4 3" /> },
  { value: 'dotted', label: 'Dotted', icon: <LineStyleIcon dash="1.5 3" /> },
];

const DIRECTION_OPTIONS: SelectOption<EdgeDirection>[] = [
  { value: 'none', label: 'No arrow', icon: <ArrowIcon /> },
  { value: 'forward', label: 'Forward', icon: <ArrowIcon right /> },
  { value: 'backward', label: 'Backward', icon: <ArrowIcon left /> },
  { value: 'both', label: 'Both', icon: <ArrowIcon left right /> },
];

const STROKE_WIDTH_OPTIONS: SelectOption<`${EdgeStrokeWidth}`>[] = (
  [1, 2, 3, 4] as const
).map((w) => ({
  value: `${w}` as `${typeof w}`,
  label: `${w}px`,
  icon: <StrokeWidthIcon width={w} />,
}));

function getEdgeStyle(edge: Edge): EdgeStyle {
  return (edge.data?.edgeStyle as EdgeStyle | undefined) ?? {};
}

/**
 * Compute the position of the edge midpoint by reading the actual SVG path
 * rendered by React Flow.  Falls back to the centre of the source/target
 * bounding box when the DOM element is not (yet) available.
 */
function useEdgeMidpoint(selectedEdge: Edge | null, nodes: Node[]) {
  return useMemo(() => {
    if (!selectedEdge) return null;

    // Try reading the rendered SVG path first
    const pathEl = document.querySelector<SVGPathElement>(
      `.react-flow__edge[data-id="${CSS.escape(selectedEdge.id)}"] path`,
    );
    if (pathEl) {
      const total = pathEl.getTotalLength();
      const pt = pathEl.getPointAtLength(total / 2);

      // The path is inside the React Flow viewport transform group, so the
      // point coordinates are already in flow-space.
      return { x: pt.x, y: pt.y };
    }

    // Fallback: compute from node centres
    const src = nodes.find((n) => n.id === selectedEdge.source);
    const tgt = nodes.find((n) => n.id === selectedEdge.target);
    if (!src || !tgt) return null;

    const sw = src.measured?.width ?? 200;
    const sh = src.measured?.height ?? 100;
    const tw = tgt.measured?.width ?? 200;
    const th = tgt.measured?.height ?? 100;

    const sx = src.position.x + sw / 2;
    const sy = src.position.y + sh / 2;
    const tx = tgt.position.x + tw / 2;
    const ty = tgt.position.y + th / 2;

    return { x: (sx + tx) / 2, y: (sy + ty) / 2 };
  }, [selectedEdge, nodes]);
}

/**
 * Floating toolbar that appears when exactly one edge is selected.
 * Provides controls for line type, dash style, color, and thickness.
 *
 * Follows the same styling pattern as MultiSelectToolbar.
 */
export const EdgeStyleToolbar = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const executeCommands = useCanvasStore((s) => s.executeCommands);

  const { zoom, x: vpX, y: vpY } = useViewport();
  const domNode = useStore((s) => s.domNode);

  const selectedEdge = useMemo(() => {
    const sel = edges.filter((e) => e.selected);
    return sel.length === 1 ? sel[0] : null;
  }, [edges]);

  const style = useMemo(
    () => (selectedEdge ? getEdgeStyle(selectedEdge) : ({} as EdgeStyle)),
    [selectedEdge],
  );

  const setStyle = useCallback(
    (patch: Partial<EdgeStyle>) => {
      if (!selectedEdge) return;
      executeCommands([
        {
          type: 'SET_EDGE_STYLE',
          edges: [
            {
              edge: selectedEdge.id as CanvasEdgeId,
              style: patch,
            },
          ],
        },
      ]);
    },
    [selectedEdge, executeCommands],
  );

  const midpoint = useEdgeMidpoint(selectedEdge, nodes);

  if (!selectedEdge || !midpoint || !domNode) return null;

  // flow → screen pixel (same formula as MultiSelectToolbar)
  const pxX = midpoint.x * zoom + vpX;
  const pxY = midpoint.y * zoom + vpY;

  const TOOLBAR_OFFSET = 48;

  const currentLineType: EdgeLineType = style.lineType ?? 'bezier';
  const currentLineStyle: EdgeLineStyle = style.lineStyle ?? 'solid';
  const currentStroke = style.stroke ?? COLOR_PALETTE[0].value;
  const currentWidth = style.strokeWidth ?? 1;
  const currentDirection: EdgeDirection = style.direction ?? 'none';

  const toolbar = (
    <div
      className="pointer-events-auto absolute z-[1000]"
      style={{
        left: pxX,
        top: pxY - TOOLBAR_OFFSET,
        transform: 'translateX(-50%)',
      }}
    >
      <FloatingToolbar>
        {/* Line type */}
        <FloatingToolbar.Select
          options={LINE_TYPE_OPTIONS}
          value={currentLineType}
          onChange={(v) => setStyle({ lineType: v })}
          iconOnly
        />

        <FloatingToolbar.Divider />

        {/* Line style */}
        <FloatingToolbar.Select
          options={LINE_STYLE_OPTIONS}
          value={currentLineStyle}
          onChange={(v) => setStyle({ lineStyle: v })}
          iconOnly
        />

        <FloatingToolbar.Divider />

        {/* Direction */}
        <FloatingToolbar.Select
          options={DIRECTION_OPTIONS}
          value={currentDirection}
          onChange={(v) => setStyle({ direction: v })}
          iconOnly
        />

        <FloatingToolbar.Divider />

        {/* Stroke width */}
        <FloatingToolbar.Select
          options={STROKE_WIDTH_OPTIONS}
          value={`${currentWidth}`}
          onChange={(v) =>
            setStyle({ strokeWidth: Number(v) as EdgeStrokeWidth })
          }
          iconOnly
        />

        <FloatingToolbar.Divider />

        {/* Color picker */}
        <FloatingToolbar.ColorPicker
          colors={COLOR_PALETTE}
          value={currentStroke}
          onSelect={(v) => setStyle({ stroke: v })}
          title="Edge color"
        />
      </FloatingToolbar>
    </div>
  );

  return createPortal(toolbar, domNode);
};
