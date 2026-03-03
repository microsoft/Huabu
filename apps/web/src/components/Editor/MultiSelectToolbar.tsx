import { useStore, useViewport } from '@xyflow/react';
import {
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Ungroup,
} from 'lucide-react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '../../store/canvasStore';
import {
  getAbsolutePosition,
  type NestableNode,
} from '../../utils/frameHelper';
import { GhostButton } from '../Common/GhostButton';

/**
 * A floating toolbar that appears horizontally centred above the
 * multi-selection bounding box when two or more nodes are selected.
 */
export const MultiSelectToolbar = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const alignSelectedNodes = useCanvasStore((s) => s.alignSelectedNodes);
  const spreadSelectedNodes = useCanvasStore((s) => s.spreadSelectedNodes);

  const { zoom, x: vpX, y: vpY } = useViewport();

  // The root .react-flow wrapper – we portal into it so our absolute
  // positioning is relative to the flow container, not the transformed viewport.
  const domNode = useStore((s) => s.domNode);

  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

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
          : node.measured?.width ?? 200;
      const h =
        typeof style?.height === 'number'
          ? style.height
          : node.measured?.height ?? 100;

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
      <div className="text-muted-foreground shadow-bottom flex items-center gap-1 rounded-lg border-0 bg-white p-1.5">
        {/* Horizontal alignment */}
        <GhostButton
          title="Align Left"
          onClick={() => alignSelectedNodes('left')}
        >
          <AlignHorizontalJustifyStart size={16} />
        </GhostButton>
        <GhostButton
          title="Align Center (H)"
          onClick={() => alignSelectedNodes('center-h')}
        >
          <AlignHorizontalJustifyCenter size={16} />
        </GhostButton>
        <GhostButton
          title="Align Right"
          onClick={() => alignSelectedNodes('right')}
        >
          <AlignHorizontalJustifyEnd size={16} />
        </GhostButton>

        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Vertical alignment */}
        <GhostButton
          title="Align Top"
          onClick={() => alignSelectedNodes('top')}
        >
          <AlignVerticalJustifyStart size={16} />
        </GhostButton>
        <GhostButton
          title="Align Center (V)"
          onClick={() => alignSelectedNodes('center-v')}
        >
          <AlignVerticalJustifyCenter size={16} />
        </GhostButton>
        <GhostButton
          title="Align Bottom"
          onClick={() => alignSelectedNodes('bottom')}
        >
          <AlignVerticalJustifyEnd size={16} />
        </GhostButton>

        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Spread apart overlapping nodes */}
        <GhostButton title="Spread Apart" onClick={() => spreadSelectedNodes()}>
          <Ungroup size={16} />
        </GhostButton>
      </div>
    </div>
  );

  return createPortal(toolbar, domNode);
};
