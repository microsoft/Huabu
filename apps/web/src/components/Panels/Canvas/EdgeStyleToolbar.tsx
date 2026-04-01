import { useStore, useViewport } from '@xyflow/react';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { STROKE_COLORS, EDGE_STROKE_WIDTHS } from '@/config/colors';
import useCanvasStore from '@/store/canvasStore';

import { Button } from '../../Common/Button';
import { ColorPicker } from '../../Common/ColorPicker';
import { Select } from '../../Common/Select';

import type { SelectOption } from '../../Common/Select';
import type { CanvasEdgeId } from '@sediment/shared';
import type { EdgeLineType, EdgeLineStyle, EdgeStyle } from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

// ---- Select options ----

const LINE_TYPE_OPTIONS: SelectOption<EdgeLineType>[] = [
  { value: 'bezier', label: 'Bezier' },
  { value: 'straight', label: 'Straight' },
  { value: 'step', label: 'Step' },
];

const LINE_STYLE_OPTIONS: SelectOption<EdgeLineStyle>[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

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

  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPanelRef = useRef<HTMLDivElement>(null);

  // Close the colour panel when clicking outside
  useEffect(() => {
    if (!showColorPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        colorPanelRef.current &&
        !colorPanelRef.current.contains(e.target as HTMLElement)
      ) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColorPicker]);

  const selectedEdge = useMemo(() => {
    const sel = edges.filter((e) => e.selected);
    return sel.length === 1 ? sel[0] : null;
  }, [edges]);

  // Reset colour picker when selected edge changes
  useEffect(() => setShowColorPicker(false), [selectedEdge?.id]);

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
  const currentStroke = style.stroke ?? STROKE_COLORS[0].value;
  const currentWidth = style.strokeWidth ?? 1;

  const toolbar = (
    <div
      className="pointer-events-auto absolute z-[1000]"
      style={{
        left: pxX,
        top: pxY - TOOLBAR_OFFSET,
        transform: 'translateX(-50%)',
      }}
    >
      {/* Main toolbar — identical container style to MultiSelectToolbar */}
      <div className="text-fg-muted shadow-bottom bg-surface flex items-center gap-1 rounded-lg border-0 p-1.5">
        {/* Line type */}
        <Select
          options={LINE_TYPE_OPTIONS}
          value={currentLineType}
          onChange={(v) => setStyle({ lineType: v })}
          size="sm"
          variant="ghost"
          align="top-left"
        />

        {/* Divider */}
        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Line style */}
        <Select
          options={LINE_STYLE_OPTIONS}
          value={currentLineStyle}
          onChange={(v) => setStyle({ lineStyle: v })}
          size="sm"
          variant="ghost"
          align="top-left"
        />

        {/* Divider */}
        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Stroke width — TextNode-style active state */}
        {EDGE_STROKE_WIDTHS.map((w) => (
          <Button
            key={w}
            variant="ghost"
            iconOnly
            size="sm"
            title={`Width ${w}px`}
            onClick={() => setStyle({ strokeWidth: w })}
            className={clsx(
              currentWidth === w
                ? 'text-info bg-info-bg enabled:hover:bg-info-bg'
                : 'text-fg-muted hover:bg-bg-default',
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <line
                x1="2"
                y1="8"
                x2="14"
                y2="8"
                stroke="currentColor"
                strokeWidth={w}
                strokeLinecap="round"
              />
            </svg>
          </Button>
        ))}

        {/* Divider */}
        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Color picker — NodeBgColorSelector style */}
        <div ref={colorPanelRef} className="relative flex items-center">
          <Button
            variant="outline"
            iconOnly
            size="sm"
            title="Edge color"
            onClick={() => setShowColorPicker(!showColorPicker)}
            className="h-6 rounded-sm"
          >
            <div
              className="border-edge-default h-3.5 w-3.5 rounded-full border"
              style={{ backgroundColor: currentStroke }}
            />
          </Button>

          {showColorPicker && (
            <div className="border-edge-default shadow-bottom animate-in fade-in zoom-in bg-surface absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-full border px-2 py-1.5 duration-200">
              <ColorPicker
                colors={STROKE_COLORS}
                activeValue={currentStroke}
                onSelect={(v) => {
                  setStyle({ stroke: v });
                  setShowColorPicker(false);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(toolbar, domNode);
};
