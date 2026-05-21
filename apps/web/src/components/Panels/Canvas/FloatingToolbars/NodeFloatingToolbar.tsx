import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
} from '@sediment/shared';
import { useInternalNode } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Tooltip } from '@/components/Common/Tooltip';
import { NODE_ICON } from '@/config/nodeIcons';
import { useIsNotMouse } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';
import { resolveGeometryEdit } from '@/utils/node/geometry';

import type { CanvasNodeType, NodeData } from '@/components/Nodes/types';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = ACCENT_NONE_TOKEN;

interface NodeFloatingToolbarProps {
  id: string;
  type: CanvasNodeType;
  data: NodeData;
  /**
   * Per-node-type toolbar content rendered immediately after the type
   * indicator. Sits in the same group as the trailing accent color
   * picker so the color swatch always becomes the last item of this
   * second-to-last group (no extra divider in between).
   */
  children?: ReactNode;
  /**
   * Per-node-type "expand" affordances rendered as the trailing item
   * of the final group, right after the size picker. Kept separate
   * from `children` so every node's expand-like action lands in the
   * same position with no extra divider preceding it.
   */
  expand?: ReactNode;
}

/**
 * Floating toolbar shown above a single selected node.
 *
 * Should only be mounted while the node is the sole selection — see
 * the call site in `NodeWrapper`. The mount gate keeps the viewport /
 * node subscriptions inside this component scoped to one canvas, not
 * one per node.
 *
 * Composes three sections:
 *  1. Leading type indicator. For `text` / `note`, renders a segmented
 *     toggle so the user can convert between them with one click.
 *  2. Caller-provided per-node-type actions (`children`) followed by
 *     the trailing accent color picker (hidden for `question` /
 *     `sketch` nodes). These share a single group with no divider
 *     between them, so the color swatch is always the last item in
 *     the second-to-last group.
 *  3. Size picker plus any caller-provided `expand` action. These
 *     share the final group with no divider between them, so the
 *     expand button is always the last item in the last group.
 *
 * A trailing delete button is appended for non-mouse input as its
 * own group (mouse users have keyboard Delete / Backspace).
 *
 * Positioning, portal-into-body, and viewport clamping are delegated
 * to `CanvasFloatingPopover`.
 */
export const NodeFloatingToolbar = memo(
  ({ id, type, data, children, expand }: NodeFloatingToolbarProps) => {
    const internalNode = useInternalNode(id);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const convertNodeType = useCanvasStore((s) => s.convertNodeType);
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);
    const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
    const ingestion = useCanvasStore((s) => s.ingestionByNodeId[id]);
    const isNotMouse = useIsNotMouse();

    // Disable the text/note toggle while the large-view editor is open
    // on this node (dirty editor state would otherwise overwrite the
    // conversion) or while an ingest is in flight.
    const isTypeToggleDisabled =
      expandedNodeId === id || ingestion?.status === 'pending';
    const typeToggleDisabledReason =
      expandedNodeId === id
        ? 'Close the editor to change type'
        : ingestion?.status === 'pending'
          ? 'Ingestion in progress'
          : null;

    // Anchor rect in flow (canvas) coordinates. `useInternalNode`
    // gives us live position + measured size, so the toolbar follows
    // drag without any extra subscription.
    const anchor = useMemo(() => {
      if (!internalNode) return null;
      const x = internalNode.internals.positionAbsolute?.x ?? 0;
      const y = internalNode.internals.positionAbsolute?.y ?? 0;
      const width =
        internalNode.measured?.width ??
        (internalNode.style?.width as number | undefined) ??
        0;
      const height =
        internalNode.measured?.height ??
        (internalNode.style?.height as number | undefined) ??
        0;
      return { x, y, width, height };
    }, [internalNode]);

    // Current size shown in the size picker. Use measured dimensions
    // (browser-actual) as the source of truth so the popup reflects the
    // node's true on-screen size, including content-driven auto-sizing.
    const currentWidth =
      internalNode?.measured?.width ??
      (internalNode?.style?.width as number | undefined) ??
      null;
    const currentHeight =
      internalNode?.measured?.height ??
      (internalNode?.style?.height as number | undefined) ??
      null;

    // ─── Note: fit-height ↔ H input linkage ────────────────────────────
    //
    // For note nodes, the H input shares state with the dedicated
    // auto-fit toggle (mirrors `handleToggleAutoHeight` in NoteNode):
    //  - Auto mode  → `style.height` is undefined, node grows with content.
    //  - Fixed mode → `style.height` is a pinned number.
    //
    // Both this toggle and the corner "show all content" affordance in
    // NoteNode observe the same store state, so they stay in sync
    // automatically. The "last pinned height" memory used by the
    // auto → fixed seed lives in the shared `noteHeightMemory` module
    // (populated by `useTrackNoteFixedHeight` on each NoteNode), so this
    // toolbar doesn't need to track it locally — `setNoteHeightMode`
    // reads from the same map regardless of which entry point triggers
    // the toggle.
    const styleHeight = internalNode?.style?.height as number | undefined;

    const beginGesture = useCanvasStore((s) => s.beginGesture);
    const isNoteAutoHeight = type === 'note' && styleHeight === undefined;
    const toggleNoteAutoHeight = useCallback(() => {
      setNoteHeightMode([id], isNoteAutoHeight ? 'fixed' : 'auto');
    }, [id, isNoteAutoHeight, setNoteHeightMode]);

    return (
      <CanvasFloatingPopover
        anchor={anchor}
        open
        offset={12}
        side="top"
        className={FLOATING_TOOLBAR_CLASS}
      >
        {/* Leading type indicator. */}
        {type === 'text' || type === 'note' ? (
          <FloatingToolbar.Group>
            <FloatingToolbar.ToggleButton
              active={type === 'text'}
              disabled={isTypeToggleDisabled}
              title={
                typeToggleDisabledReason ??
                (type === 'text' ? 'Text' : 'Convert to Text')
              }
              onClick={() => convertNodeType(id, 'text')}
            >
              <NODE_ICON.text />
            </FloatingToolbar.ToggleButton>
            <FloatingToolbar.ToggleButton
              active={type === 'note'}
              disabled={isTypeToggleDisabled}
              title={
                typeToggleDisabledReason ??
                (type === 'note' ? 'Note' : 'Convert to Note')
              }
              onClick={() => convertNodeType(id, 'note')}
            >
              <NODE_ICON.note />
            </FloatingToolbar.ToggleButton>
          </FloatingToolbar.Group>
        ) : (
          <Tooltip content={type}>
            <div className="text-fg-subtle flex items-center px-1">
              {(() => {
                const TypeIcon = NODE_ICON[type];
                return <TypeIcon size={14} />;
              })()}
            </div>
          </Tooltip>
        )}

        <div className="bg-edge-default mx-0.5 h-4 w-px" />

        {children}

        {type !== 'question' && type !== 'sketch' && (
          <FloatingToolbar.ColorPicker
            colors={
              type === 'text'
                ? ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT
                : ACCENT_PICKER_OPTIONS
            }
            value={data.style?.accent ?? ACCENT_NONE}
            onSelect={(t) =>
              updateNodeData(id, {
                style: {
                  ...data.style,
                  accent: t === ACCENT_NONE ? null : t,
                },
              })
            }
            title="Accent Color"
          />
        )}

        <FloatingToolbar.Divider />

        <FloatingToolbar.SizePicker
          width={currentWidth}
          height={currentHeight}
          onApply={({ width, height }) => {
            if (!internalNode) return;
            // `resolveGeometryEdit` falls back to existing width when only
            // height was edited, preserves pinned-vs-auto height when the
            // user didn't enter a height, and rejects items whose width
            // can't be resolved to a positive number.
            const resolved = resolveGeometryEdit(internalNode, {
              width,
              height,
            });
            if (!resolved) return;
            // SET_NODE_GEOMETRY uses snapshot:'caller' — open a gesture so
            // the resize is captured as one undo entry without warnings.
            beginGesture('SET_NODE_GEOMETRY');
            setNodeGeometry([
              {
                nodeId: id,
                size: { width: resolved.width, height: resolved.height },
              },
            ]);
          }}
          heightAuto={
            type === 'note'
              ? {
                  active: isNoteAutoHeight,
                  onToggle: toggleNoteAutoHeight,
                  title: isNoteAutoHeight
                    ? 'Switch to fixed height'
                    : 'Fit height to content',
                }
              : undefined
          }
        />

        {expand}

        {/* Non-mouse only: mouse users have keyboard Delete / Backspace. */}
        {isNotMouse && (
          <>
            <FloatingToolbar.Divider />
            <FloatingToolbar.ActionButton
              title="Delete"
              tone="danger"
              onClick={() => deleteNodes([id])}
            >
              <Trash2 />
            </FloatingToolbar.ActionButton>
          </>
        )}
      </CanvasFloatingPopover>
    );
  },
);
NodeFloatingToolbar.displayName = 'NodeFloatingToolbar';
