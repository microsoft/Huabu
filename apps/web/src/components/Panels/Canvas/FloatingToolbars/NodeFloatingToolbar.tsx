import { useInternalNode } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';

import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  type FrameNodeData,
} from '@sediment/shared';
import { isAlwaysAutoHeightNodeType } from '@sediment/shared/canvas-engine';

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
   * Group 3 — canvas display effects.
   * Buttons/controls that change how the node renders on the canvas:
   * text formatting (bold/italic/font), sketch stroke controls,
   * frame layout, note height mode, etc.
   * Rendered between the color+size group and the actions group.
   */
  toolbar?: ReactNode;
  /**
   * Group 4 — node actions.
   * Buttons that trigger operations on the node: open large/fullscreen
   * view, apply AI sketch recognition, download, unframe, start/cancel
   * AI runs, open conversation thread, etc.
   * Rendered as the last group before the optional delete button.
   */
  actions?: ReactNode;
}

/**
 * Floating toolbar shown above a single selected node.
 *
 * Should only be mounted while the node is the sole selection — see
 * the call site in `NodeWrapper`. The mount gate keeps the viewport /
 * node subscriptions inside this component scoped to one canvas, not
 * one per node.
 *
 * Composes four groups separated by dividers:
 *  1. Type indicator. For `text` / `note`, a toggle to convert between them;
 *     for other nodes, a plain type icon.
 *  2. Style: accent color picker (hidden for `question` / `sketch`) + size
 *     picker. Always present.
 *  3. Canvas display (`toolbar` prop). Controls that change how the node is
 *     rendered on the canvas — text formatting, sketch stroke controls, frame
 *     child layout, etc. Omitted when the prop is undefined.
 *  4. Actions (`actions` prop). Buttons that trigger operations — open
 *     large/fullscreen view, AI sketch recognition, download, unframe, run /
 *     cancel AI question, etc. Omitted when the prop is undefined.
 *
 * A trailing delete button is appended for non-mouse input (mouse users have
 * keyboard Delete / Backspace).
 *
 * Positioning, portal-into-body, and viewport clamping are delegated to
 * `CanvasFloatingPopover`.
 */
export const NodeFloatingToolbar = memo(
  ({ id, type, data, toolbar, actions }: NodeFloatingToolbarProps) => {
    const internalNode = useInternalNode(id);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const convertNodeType = useCanvasStore((s) => s.convertNodeType);
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);
    const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
    const ingestion = useCanvasStore((s) => s.ingestionByNodeId[id]);
    const isNotMouse = useIsNotMouse();
    const isTextFlowNode = isAlwaysAutoHeightNodeType(type);

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
    //
    // Prefer the explicit `style.{width,height}` over
    // `measured.{width,height}` whenever it is pinned: during a live
    // resize, the snap-mirror writes the authoritative snapped rect to
    // `style` *every* `onNodesChange` tick, while `measured` is updated
    // asynchronously by RF's `ResizeObserver` and therefore lags by one
    // frame. Using `measured` first made both the toolbar's anchor
    // position and the W/H values in the size picker trail the resize
    // handle by a frame (visible jitter at gesture end). For auto-sized
    // nodes (notes in auto-height mode, etc.) `style.height` is
    // `undefined`, so we still fall through to `measured` and the
    // displayed value reflects the content-driven height.
    const anchor = useMemo(() => {
      if (!internalNode) return null;
      const x = internalNode.internals.positionAbsolute?.x ?? 0;
      const y = internalNode.internals.positionAbsolute?.y ?? 0;
      const styleW = internalNode.style?.width as number | undefined;
      const styleH = internalNode.style?.height as number | undefined;
      const width = styleW ?? internalNode.measured?.width ?? 0;
      const height = styleH ?? internalNode.measured?.height ?? 0;
      return { x, y, width, height };
    }, [internalNode]);

    // Current size shown in the size picker. Same source-of-truth
    // ordering as the anchor above: pinned `style` first, content-driven
    // `measured` only when the style entry is undefined.
    const currentWidth =
      (internalNode?.style?.width as number | undefined) ??
      internalNode?.measured?.width ??
      null;
    const currentHeight =
      (internalNode?.style?.height as number | undefined) ??
      internalNode?.measured?.height ??
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

    // ─── Frame: hug ↔ manual ↔ size input linkage ──────────────────────
    //
    // For frame nodes, the size picker doubles as the hug / manual
    // toggle:
    //  - `hug`    → W and H render as italic hints showing the
    //               content-driven measured size. Typing into either
    //               input pins the frame to manual size in the same
    //               undo step as the geometry change.
    //  - `manual` → W and H render normally; typing dispatches a
    //               plain resize. The toggle next to H flips back to
    //               hug, which immediately refits the frame to its
    //               children via the engine's end-of-batch pass.
    //
    // Wired here (rather than inside `FrameNode`) so the size picker
    // stays in Group 2 alongside every other node type's geometry
    // controls.
    const dispatchUiIntent = useCanvasStore((s) => s.dispatchUiIntent);
    const isFrame = type === 'frame';
    const frameData = isFrame ? (data as FrameNodeData) : null;
    const frameSizing = frameData?.sizing ?? 'hug';
    const frameLayoutMode = frameData?.layoutMode ?? 'free';
    const isFrameHug = isFrame && frameSizing === 'hug';
    const toggleFrameSizing = useCallback(() => {
      dispatchUiIntent({
        type: 'SET_FRAME_LAYOUT_MODE',
        frameId: id,
        mode: frameLayoutMode,
        sizing: frameSizing === 'hug' ? 'manual' : 'hug',
      });
    }, [dispatchUiIntent, id, frameLayoutMode, frameSizing]);

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

        {/* ── Group 2: Style — color + size ── */}
        {type !== 'question' && type !== 'sketch' && (
          <FloatingToolbar.ColorPicker
            colors={ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT}
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

        <FloatingToolbar.SizePicker
          width={currentWidth}
          height={isTextFlowNode ? null : currentHeight}
          showHeight={!isTextFlowNode}
          onApply={({ width, height }) => {
            if (!internalNode) return;
            const resolved = resolveGeometryEdit(internalNode, {
              width,
              height,
            });
            if (!resolved) return;
            beginGesture('SET_NODE_GEOMETRY');
            // Frame in hug mode: typing an explicit W or H is a
            // direct-manipulation signal to switch the frame's sizing
            // policy to manual. Dispatch the policy change first
            // (inside the same gesture) so both intents fold into one
            // undo entry and the geometry write isn't reverted by the
            // engine's end-of-batch refit pass.
            if (isFrameHug) {
              dispatchUiIntent({
                type: 'SET_FRAME_LAYOUT_MODE',
                frameId: id,
                mode: frameLayoutMode,
                sizing: 'manual',
              });
            }
            setNodeGeometry([
              {
                nodeId: id,
                size: {
                  width: resolved.width,
                  height: resolved.height,
                },
              },
            ]);
          }}
          autoSize={
            isFrame
              ? {
                  dimensions: 'both',
                  active: isFrameHug,
                  onToggle: toggleFrameSizing,
                  title: isFrameHug
                    ? 'Switch to manual size'
                    : 'Fit size to content',
                }
              : undefined
          }
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

        {isTextFlowNode && (
          <FloatingToolbar.NumberInput
            label="Font"
            ariaLabel="Font size"
            value={data.style?.fontSize ?? 16}
            min={8}
            max={160}
            onApply={(fontSize) => {
              updateNodeData(id, {
                style: { ...(data.style ?? {}), fontSize },
              });
            }}
          />
        )}

        {/* ── Group 3: Canvas display effects ── */}
        {toolbar && (
          <>
            <FloatingToolbar.Divider />
            {toolbar}
          </>
        )}

        {/* ── Group 4: Actions ── */}
        {actions && (
          <>
            <FloatingToolbar.Divider />
            {actions}
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
