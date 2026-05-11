import { ACCENT_PALETTE } from '@sediment/shared';
import { useStore, useViewport } from '@xyflow/react';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Ungroup,
} from 'lucide-react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import {
  getAbsolutePosition,
  type NestableNode,
} from '@/handler/canvasCommand/utils/frame';
import useCanvasStore from '@/store/canvasStore';

import type { ColorPreset } from '@/components/Common/ColorPicker';
import type { CanvasNode } from '@/components/Nodes/types';
import type { CanvasNodeId } from '@sediment/shared';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = 'none';

/** Accent palette options for the picker: leading "Transparent" + true
 *  "White" + saturated accents. Mirrors the per-node picker in NodeWrapper. */
const ACCENT_PICKER_OPTIONS: ColorPreset[] = [
  { token: ACCENT_NONE, name: 'Transparent', value: 'transparent' },
  { token: 'white', name: 'White', value: '#ffffff' },
  ...ACCENT_PALETTE,
];

/**
 * A floating toolbar that appears horizontally centred above the
 * multi-selection bounding box when two or more nodes are selected.
 */
export const MultiSelectToolbar = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const alignSelectedNodes = useCanvasStore((s) => s.alignSelectedNodes);
  const spreadSelectedNodes = useCanvasStore((s) => s.spreadSelectedNodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);

  const { zoom, x: vpX, y: vpY } = useViewport();

  // The root .react-flow wrapper – we portal into it so our absolute
  // positioning is relative to the flow container, not the transformed viewport.
  const domNode = useStore((s) => s.domNode);

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  // Determine the common accent among selected nodes (empty string if mixed)
  const commonAccent = useMemo(() => {
    if (selectedNodes.length === 0) return ACCENT_NONE;
    const first = selectedNodes[0].data?.style?.accent ?? null;
    const allSame = selectedNodes.every(
      (n) => (n.data?.style?.accent ?? null) === first,
    );
    return allSame ? (first ?? ACCENT_NONE) : ACCENT_NONE;
  }, [selectedNodes]);

  // Compute bounding box of selected nodes in flow (absolute) coordinates
  const selectionBounds = useMemo(() => {
    if (selectedNodes.length < 2) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of selectedNodes) {
      const absPos = getAbsolutePosition(nodes as NestableNode[], node.id);
      const pos = absPos ?? node.position;

      const style = node.style as
        | { width?: number; height?: number }
        | undefined;
      const w =
        typeof style?.width === 'number'
          ? style.width
          : (node.measured?.width ?? 200);
      const h =
        typeof style?.height === 'number'
          ? style.height
          : (node.measured?.height ?? 100);

      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + w);
      maxY = Math.max(maxY, pos.y + h);
    }

    return { minX, minY, maxX, maxY };
  }, [selectedNodes, nodes]);

  if (!selectionBounds || selectedNodes.length < 2 || !domNode) return null;

  // Horizontal center & top edge of the bounding box, converted to
  // screen-space pixels relative to the .react-flow container.
  const centerFlowX = (selectionBounds.minX + selectionBounds.maxX) / 2;
  const topFlowY = selectionBounds.minY;

  // flow → pixel inside container:  px = flowCoord * zoom + viewportOffset
  const pxCenterX = centerFlowX * zoom + vpX;
  const pxTopY = topFlowY * zoom + vpY;

  // 48 px above the top edge so the toolbar floats above the selection box
  const TOOLBAR_OFFSET = 48;

  const toolbar = (
    <div
      className="pointer-events-auto absolute z-[1000]"
      style={{
        left: pxCenterX,
        top: pxTopY - TOOLBAR_OFFSET,
        transform: 'translateX(-50%)',
      }}
    >
      <FloatingToolbar>
        {/* Horizontal alignment */}
        <FloatingToolbar.ActionButton
          title="Align Left"
          onClick={() => alignSelectedNodes('left')}
        >
          <AlignStartVertical />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title="Align Center"
          onClick={() => alignSelectedNodes('center-h')}
        >
          <AlignCenterVertical />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title="Align Right"
          onClick={() => alignSelectedNodes('right')}
        >
          <AlignEndVertical />
        </FloatingToolbar.ActionButton>

        <FloatingToolbar.Divider />

        {/* Vertical alignment */}
        <FloatingToolbar.ActionButton
          title="Align Top"
          onClick={() => alignSelectedNodes('top')}
        >
          <AlignStartHorizontal />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title="Align Middle"
          onClick={() => alignSelectedNodes('center-v')}
        >
          <AlignCenterHorizontal />
        </FloatingToolbar.ActionButton>
        <FloatingToolbar.ActionButton
          title="Align Bottom"
          onClick={() => alignSelectedNodes('bottom')}
        >
          <AlignEndHorizontal />
        </FloatingToolbar.ActionButton>

        <FloatingToolbar.Divider />

        {/* Spread apart overlapping nodes */}
        <FloatingToolbar.ActionButton
          title="Spread Apart"
          onClick={() => spreadSelectedNodes()}
        >
          <Ungroup />
        </FloatingToolbar.ActionButton>

        <FloatingToolbar.Divider />

        {/* Accent color for all selected nodes */}
        <FloatingToolbar.ColorPicker
          colors={ACCENT_PICKER_OPTIONS}
          value={commonAccent}
          onSelect={(t) => {
            const accent = t === ACCENT_NONE ? null : t;
            if (selectedNodes.length === 0) return;

            executeCommands([
              {
                type: 'MERGE_NODE_DATA',
                patches: selectedNodes.map((node) => ({
                  nodeId: node.id as CanvasNodeId,
                  patch: {
                    style: { ...node.data?.style, accent },
                  },
                })),
              },
            ]);
          }}
          title="Accent Color"
        />
      </FloatingToolbar>
    </div>
  );

  return createPortal(toolbar, domNode);
};
