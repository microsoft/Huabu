import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
} from '@sediment/shared';
import { useInternalNode } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Tooltip } from '@/components/Common/Tooltip';
import { NODE_ICON } from '@/config/nodeIcons';
import { useIsNotMouse } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasNodeType, NodeData } from './types';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = ACCENT_NONE_TOKEN;

interface NodeFloatingToolbarProps {
  id: string;
  type: CanvasNodeType;
  data: NodeData;
  /**
   * Per-node-type toolbar content rendered between the type indicator
   * and the trailing accent color picker.
   */
  children: ReactNode;
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
 *  2. Caller-provided per-node-type actions (`children`).
 *  3. Trailing accent color picker (hidden for `question` nodes).
 *
 * Positioning, portal-into-body, and viewport clamping are delegated
 * to `CanvasFloatingPopover`.
 */
export const NodeFloatingToolbar = memo(
  ({ id, type, data, children }: NodeFloatingToolbarProps) => {
    const internalNode = useInternalNode(id);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const convertNodeType = useCanvasStore((s) => s.convertNodeType);
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);
    const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
    const ingestion = useCanvasStore((s) => s.ingestionByNodeId[id]);
    const isNotMouse = useIsNotMouse();

    // Disable the text/note toggle while the large-view editor is open
    // on this node (BlockNote dirty state would otherwise overwrite the
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

        <div className="bg-border mx-0.5 h-4 w-px" />

        {children}

        {type !== 'question' && (
          <>
            <FloatingToolbar.Divider />
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
          </>
        )}

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
