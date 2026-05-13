import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
} from '@sediment/shared';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Sparkles,
  Trash2,
  Ungroup,
} from 'lucide-react';
import { useMemo } from 'react';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import {
  getAbsolutePosition,
  type NestableNode,
} from '@/handler/canvasCommand/utils/frame';
import { useIsNotMouse } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';
import { useIntentStore } from '@/store/intentStore';

import type { CanvasNode } from '@/components/Nodes/types';
import type { CanvasNodeId } from '@sediment/shared';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = ACCENT_NONE_TOKEN;

/**
 * A floating toolbar that appears horizontally centred above the
 * multi-selection bounding box when two or more nodes are selected.
 */
export const MultiSelectToolbar = () => {
  const nodes = useCanvasStore((s) => s.nodes);
  const alignSelectedNodes = useCanvasStore((s) => s.alignSelectedNodes);
  const spreadSelectedNodes = useCanvasStore((s) => s.spreadSelectedNodes);
  const executeCommands = useCanvasStore((s) => s.executeCommands);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const requestSketchRecognition = useIntentStore(
    (s) => s.requestSketchRecognition,
  );
  const isNotMouse = useIsNotMouse();

  const selectedNodes = useMemo(
    () => nodes.filter((n) => n.selected) as CanvasNode[],
    [nodes],
  );

  // Sketch (annotation) selections expose an `Apply Sketch` action that
  // hands the selected stroke ids to the vision-LLM recognition pipeline.
  // Shown only when *every* selected node is a sketch — mixing in regular
  // nodes would make the gesture's intent ambiguous.
  const sketchIds = useMemo(
    () =>
      selectedNodes.length > 0 &&
      selectedNodes.every((n) => n.type === 'annotation')
        ? selectedNodes.map((n) => n.id)
        : null,
    [selectedNodes],
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

  // Only expose the "Transparent" swatch when *every* selected node is a
  // text node. The moment the selection contains any other type (frame,
  // note, image, pdf, video, web, annotation), transparent is hidden
  // because those types need a solid background to remain visible.
  const accentPickerOptions = useMemo(
    () =>
      selectedNodes.length > 0 && selectedNodes.every((n) => n.type === 'text')
        ? ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT
        : ACCENT_PICKER_OPTIONS,
    [selectedNodes],
  );

  // Compute bounding box of selected nodes in flow (absolute) coordinates.
  // Returned as a `CanvasFloatingPopover` anchor rect.
  const anchor = useMemo(() => {
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

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [selectedNodes, nodes]);

  return (
    <CanvasFloatingPopover
      anchor={anchor}
      open={selectedNodes.length >= 2}
      offset={12}
      side="top"
      className={FLOATING_TOOLBAR_CLASS}
    >
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

      {sketchIds && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title="Apply Sketch (interpret strokes with AI)"
            onClick={() => requestSketchRecognition(sketchIds)}
          >
            <Sparkles />
          </FloatingToolbar.ActionButton>
        </>
      )}

      <FloatingToolbar.Divider />

      {/* Accent color for all selected nodes */}
      <FloatingToolbar.ColorPicker
        colors={accentPickerOptions}
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

      {/* Non-mouse only: mouse users have keyboard Delete / Backspace. */}
      {isNotMouse && (
        <>
          <FloatingToolbar.Divider />
          <FloatingToolbar.ActionButton
            title="Delete Selected"
            tone="danger"
            onClick={() => {
              if (selectedNodes.length === 0) return;
              deleteNodes(selectedNodes.map((n) => n.id));
            }}
          >
            <Trash2 />
          </FloatingToolbar.ActionButton>
        </>
      )}
    </CanvasFloatingPopover>
  );
};
