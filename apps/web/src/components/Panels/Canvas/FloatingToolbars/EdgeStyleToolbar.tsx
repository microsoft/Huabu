// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ACCENT_PALETTE, EDGE_STROKE_WIDTHS } from '@huabu/shared';
import {
  DEFAULT_EDGE_STROKE_TOKEN,
  DEFAULT_EDGE_STROKE_WIDTH,
} from '@huabu/shared/canvas-engine';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { translateColorOptions } from '@/i18n/colors';
import useCanvasStore from '@/store/canvasStore';

import type { SelectOption } from '@/components/Common/Select';
import type { CanvasEdgeId } from '@huabu/shared';
import type {
  EdgeLineType,
  EdgeLineStyle,
  EdgeDirection,
  EdgeStyle,
  EdgeStrokeWidth,
} from '@huabu/shared';
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

const STROKE_WIDTH_OPTIONS: SelectOption<`${EdgeStrokeWidth}`>[] =
  EDGE_STROKE_WIDTHS.map((w) => ({
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
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const disconnectEdges = useCanvasStore((s) => s.disconnectEdges);
  const isNotMouse = useIsNotMouse();

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

  // Treat the midpoint as a 0×0 anchor rect so `CanvasFloatingPopover`
  // centres the toolbar on the point and clamps it inside the viewport.
  const anchor = useMemo(
    () =>
      midpoint ? { x: midpoint.x, y: midpoint.y, width: 0, height: 0 } : null,
    [midpoint],
  );

  const currentLineType: EdgeLineType = style.lineType ?? 'bezier';
  const currentLineStyle: EdgeLineStyle = style.lineStyle ?? 'solid';
  const currentStroke = style.stroke ?? DEFAULT_EDGE_STROKE_TOKEN;
  const currentWidth = style.strokeWidth ?? DEFAULT_EDGE_STROKE_WIDTH;
  const currentDirection: EdgeDirection = style.direction ?? 'none';
  const accentColors = useMemo(
    () => translateColorOptions(ACCENT_PALETTE, t),
    [t],
  );

  const lineTypeOptions = useMemo<SelectOption<EdgeLineType>[]>(
    () => [
      {
        value: 'bezier',
        label: t('edgeToolbar.lineType.bezier'),
        icon: <LineTypeIcon type="bezier" />,
      },
      {
        value: 'straight',
        label: t('edgeToolbar.lineType.straight'),
        icon: <LineTypeIcon type="straight" />,
      },
      {
        value: 'step',
        label: t('edgeToolbar.lineType.step'),
        icon: <LineTypeIcon type="step" />,
      },
    ],
    [t],
  );

  const lineStyleOptions = useMemo<SelectOption<EdgeLineStyle>[]>(
    () => [
      {
        value: 'solid',
        label: t('edgeToolbar.lineStyle.solid'),
        icon: <LineStyleIcon />,
      },
      {
        value: 'dashed',
        label: t('edgeToolbar.lineStyle.dashed'),
        icon: <LineStyleIcon dash="4 3" />,
      },
      {
        value: 'dotted',
        label: t('edgeToolbar.lineStyle.dotted'),
        icon: <LineStyleIcon dash="1.5 3" />,
      },
    ],
    [t],
  );

  const directionOptions = useMemo<SelectOption<EdgeDirection>[]>(
    () => [
      {
        value: 'none',
        label: t('edgeToolbar.direction.none'),
        icon: <ArrowIcon />,
      },
      {
        value: 'forward',
        label: t('edgeToolbar.direction.forward'),
        icon: <ArrowIcon right />,
      },
      {
        value: 'backward',
        label: t('edgeToolbar.direction.backward'),
        icon: <ArrowIcon left />,
      },
      {
        value: 'both',
        label: t('edgeToolbar.direction.both'),
        icon: <ArrowIcon left right />,
      },
    ],
    [t],
  );

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={!!selectedEdge && !!anchor}
      // The label pill renders centred on the edge midpoint (the same
      // anchor), so a small offset would overlap it. 36px clears the
      // pill height (~22px) plus visual breathing room.
      offset={36}
      side="top"
      className={FLOATING_TOOLBAR_CLASS}
    >
      <FloatingToolbar.Select
        label={t('edgeToolbar.type')}
        options={lineTypeOptions}
        value={currentLineType}
        onChange={(v) => setStyle({ lineType: v })}
        iconOnly
      />

      <FloatingToolbar.Divider />

      <FloatingToolbar.Select
        label={t('edgeToolbar.style')}
        options={lineStyleOptions}
        value={currentLineStyle}
        onChange={(v) => setStyle({ lineStyle: v })}
        iconOnly
      />

      <FloatingToolbar.Divider />

      <FloatingToolbar.Select
        label={t('edgeToolbar.arrow')}
        options={directionOptions}
        value={currentDirection}
        onChange={(v) => setStyle({ direction: v })}
        iconOnly
      />

      <FloatingToolbar.Divider />

      <FloatingToolbar.Select
        label={t('edgeToolbar.width')}
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
        colors={accentColors}
        value={currentStroke}
        onSelect={(token) => setStyle({ stroke: token })}
        title={t('edgeToolbar.edgeColor')}
      />

      {/* Non-mouse only: mouse users have keyboard Delete / Backspace. */}
      {isNotMouse && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title={t('edgeToolbar.deleteEdge')}
            tone="danger"
            onClick={() => {
              if (selectedEdge) disconnectEdges([selectedEdge.id]);
            }}
          >
            <Trash2 />
          </FloatingToolbar.ActionButton>
        </>
      )}
    </CanvasFloatingPopover>
  );
};
