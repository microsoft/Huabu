// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  type FrameNodeData,
} from '@huabu/shared';
import { isAlwaysAutoHeightNodeType } from '@huabu/shared/canvas-engine';

import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
} from '@/components/Common/FloatingToolbar';
import { Tooltip } from '@/components/Common/Tooltip';
import { useHeightMode } from '@/components/Nodes/shared/height/useHeightMode';
import { NODE_ICON } from '@/config/nodeIcons';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useMultiSelectModifierHeld } from '@/hooks/useMultiSelectModifier';
import { translateColorOptions } from '@/i18n/colors';
import useCanvasStore from '@/store/canvasStore';
import {
  blendedMarkRect,
  useNodeCollapseStore,
} from '@/store/nodeCollapseStore';
import {
  selectIsNodeOpen,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';
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
   * view, download, unframe, start/cancel AI runs, open conversation
   * thread, etc.
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
 *     large/fullscreen view, download, unframe, run / cancel AI question,
 *     etc. Omitted when the prop is undefined.
 *
 * A trailing delete button is appended for non-mouse input (mouse users have
 * keyboard Delete / Backspace).
 *
 * Positioning, portal-into-body, and viewport clamping are delegated to
 * `CanvasFloatingPopover`.
 */
export const NodeFloatingToolbar = memo(
  ({ id, type, data, toolbar, actions }: NodeFloatingToolbarProps) => {
    const { t } = useTranslation();
    const internalNode = useInternalNode(id);
    // While the node is collapsed to its takeover mark the card has faded
    // out, so the toolbar anchors to the mark instead of hovering above the
    // top edge of an invisible rectangle.
    const mark = useNodeCollapseStore((s) => s.marks[id]);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const convertNodeType = useCanvasStore((s) => s.convertNodeType);
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);
    const setNodeGeometry = useCanvasStore((s) => s.setNodeGeometry);
    const setNoteHeightMode = useCanvasStore((s) => s.setNoteHeightMode);
    const isOpenInPreview = usePreviewWorkspaceStore((s) =>
      selectIsNodeOpen(s, id),
    );
    const ingestion = useCanvasStore((s) => s.ingestionByNodeId[id]);
    const isNotMouse = useIsNotMouse();
    // While the user holds the multi-select modifier (Ctrl / Cmd) they are
    // reaching for *another* node to add to the selection — this toolbar,
    // pinned above the current node, would occlude that target. Stand it
    // down for the duration of the hold; it returns the moment the key is
    // released (or once the multi-selection lands, at which point the
    // single-node toolbar is replaced by the multi-select one anyway).
    const multiSelectModifierHeld = useMultiSelectModifierHeld();
    const isTextFlowNode = isAlwaysAutoHeightNodeType(type);
    const accentPickerOptions = useMemo(
      () => translateColorOptions(ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT, t),
      [t],
    );

    // Disable the text/note toggle while the large-view editor is open
    // on this node (dirty editor state would otherwise overwrite the
    // conversion) or while an ingest is in flight.
    const isTypeToggleDisabled =
      isOpenInPreview || ingestion?.status === 'pending';
    const typeToggleDisabledReason = isOpenInPreview
      ? t('toolbar.closeEditorChangeType')
      : ingestion?.status === 'pending'
        ? t('toolbar.ingestionInProgress')
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
      return mark ? blendedMarkRect(mark) : { x, y, width, height };
    }, [internalNode, mark]);

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
    // auto-fit toggle. Ownership is read through the shared resolver
    // rather than from the presence of `style.height`: an auto note
    // carries a materialized number too, so the old `=== undefined`
    // check would report every note as pinned.
    //
    // This indicator is also how the user learns that dragging the resize
    // handle pinned the height — an implicit auto → fixed flip that would
    // otherwise be invisible.
    //
    // This toggle is the *only* way to unpin a note: NoteNode's corner
    // fade is a truncation hint, not a control, because a full-width
    // click target at the card's bottom edge was hit by accident far
    // more often than on purpose. The "last pinned height" memory used
    // by the auto → fixed seed lives in the shared `noteHeightMemory`
    // module (populated by `useTrackNoteFixedHeight` on each NoteNode),
    // so this toolbar doesn't need to track it locally.
    const beginGesture = useCanvasStore((s) => s.beginGesture);
    const heightMode = useHeightMode(id);
    const isNoteAutoHeight = type === 'note' && heightMode === 'auto';
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
    const isCanvasRef = type === 'canvasRef';
    const isFrameRef = type === 'frameRef';
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
        open={!multiSelectModifierHeld}
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
                (type === 'text'
                  ? t('layers.filterLabels.text')
                  : t('toolbar.convertToText'))
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
                (type === 'note'
                  ? t('layers.filterLabels.note')
                  : t('toolbar.convertToNote'))
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
        {type !== 'question' && type !== 'sketch' && !isCanvasRef && (
          <FloatingToolbar.ColorPicker
            colors={accentPickerOptions}
            value={data.style?.accent ?? ACCENT_NONE}
            onSelect={(t) =>
              updateNodeData(id, {
                style: {
                  ...data.style,
                  accent: t === ACCENT_NONE ? null : t,
                },
              })
            }
            title={t('toolbar.accentColor')}
          />
        )}

        {!isCanvasRef && !isFrameRef && (
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
                  }
                : undefined
            }
            heightAuto={
              type === 'note'
                ? {
                    active: isNoteAutoHeight,
                    onToggle: toggleNoteAutoHeight,
                  }
                : undefined
            }
          />
        )}

        {isTextFlowNode && (
          <FloatingToolbar.NumberInput
            label="Font"
            ariaLabel="Font size"
            name="font-size"
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
              title={t('actions.delete')}
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
