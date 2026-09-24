// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useInternalNode } from '@xyflow/react';
import {
  Ellipsis,
  Link,
  SquareArrowRightEnter,
  Settings2,
  Trash2,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { ACCENT_NONE_TOKEN, type FrameNodeData } from '@huabu/shared';
import {
  isAlwaysAutoHeightNodeType,
  SPACE_SHORTCUT_SIZE,
} from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { CanvasFloatingPopover } from '@/components/Common/CanvasFloatingPopover';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import {
  FloatingToolbar,
  FLOATING_TOOLBAR_CLASS,
  FLOATING_TOOLBAR_POPOVER_CLASS,
} from '@/components/Common/FloatingToolbar';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import { useHeightMode } from '@/components/Nodes/shared/height/useHeightMode';
import { SpaceShortcutWidthSettings } from '@/components/Nodes/spacePreview/SpaceShortcutWidthSettings';
import { NODE_ICON } from '@/config/nodeIcons';
import { nodeToolbarOffset } from '@/config/nodeInteractionChrome';
import { QUESTION_CARD_SCALE_RANGE } from '@/handler/canvasCommand/resolvers/resolveSetQuestionCardScale';
import { resolveUiIntent } from '@/handler/canvasCommand/uiIntent';
import { handleCanvasNavigationKey } from '@/hooks/shortcuts/handleCanvasNavigationKey';
import { handleCanvasFocusEscape } from '@/hooks/useCanvasFocusEscape';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useMultiSelectModifierHeld } from '@/hooks/useMultiSelectModifier';
import { useTakeoverMarkDrag } from '@/hooks/useTakeoverMarkDrag';
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
import { copyToClipboard } from '@/utils/io/clipboard';
import { resolveGeometryEdit } from '@/utils/node/geometry';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';
import { buildNodeDeepLink } from '@/utils/nodeDeepLink';

import {
  nodeAccentPickerOptions,
  nodeAccentPickerValue,
} from './nodeAccentPickerOptions';
import { TextFontSizePicker } from './TextFontSizePicker';

import type { CanvasNodeType, NodeData } from '@/components/Nodes/types';

import './NodeToolbar.css';

/** Sentinel token representing "no accent". */
const ACCENT_NONE = ACCENT_NONE_TOKEN;

interface NodeFloatingToolbarProps {
  id: string;
  type: CanvasNodeType;
  data: NodeData;
  /**
   * Primary display controls. Text and Sketch controls precede dimensions.
   */
  toolbar?: ReactNode;
  /**
   * Primary node actions, rendered after dimensions and display controls.
   */
  actions?: ReactNode;
  overflow?: ReactNode;
  dragEnabled: boolean;
  dragActive?: boolean;
  onDragActiveChange?: (active: boolean) => void;
}

/** Portalled chrome cannot delegate pointer dragging to a React Flow node ancestor. */
function ToolbarTypeButton({
  id,
  type,
  dragEnabled,
  active,
  disabled,
  title,
  onClick,
  onActiveChange,
}: {
  id: string;
  type: CanvasNodeType;
  dragEnabled: boolean;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const releasedNormally = useRef(false);
  const cancelledClick = useRef(false);
  const drag = useTakeoverMarkDrag(id, {
    enabled: dragEnabled && !disabled,
    soleSelectionOnly: true,
    onActiveChange: (active) => {
      // A cancelled pending press must not convert either, even before drag lock.
      if (!active && !releasedNormally.current) cancelledClick.current = true;
      onActiveChange?.(active);
    },
  });
  const TypeIcon = NODE_ICON[type];
  return (
    <Button
      {...drag}
      onPointerDown={(event) => {
        releasedNormally.current = false;
        cancelledClick.current = false;
        drag.onPointerDown(event);
      }}
      onPointerUp={(event) => {
        releasedNormally.current = event.currentTarget.hasPointerCapture(
          event.pointerId,
        );
        drag.onPointerUp(event);
      }}
      onClickCapture={(event) => {
        drag.onClickCapture(event);
        if (cancelledClick.current) {
          cancelledClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      variant="ghost"
      iconOnly
      size={active === undefined ? 'md' : 'sm'}
      aria-pressed={active}
      disabled={disabled}
      data-node-drag-handle={dragEnabled && !disabled ? '' : undefined}
      title={
        dragEnabled && !disabled
          ? `${title ?? type} · ${t('node.dragToMove')}`
          : (title ?? type)
      }
      onClick={() =>
        onClick
          ? onClick()
          : useCanvasStore
              .getState()
              .canvasWrapper?.focus({ preventScroll: true })
      }
      className={`nodrag nopan flex shrink-0 items-center justify-center rounded select-none ${
        active
          ? 'text-info bg-info-bg enabled:hover:bg-info-bg'
          : 'text-fg-muted hover:bg-hover hover:text-fg-default'
      } ${dragEnabled && !disabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={{
        width: 32,
        height: 32,
        touchAction: dragEnabled && !disabled ? 'none' : undefined,
      }}
    >
      <TypeIcon aria-hidden className="pointer-events-none" />
    </Button>
  );
}

/**
 * Floating toolbar shown above a single selected node.
 *
 * Should only be mounted while the node is the sole selection — see
 * the call site in `NodeWrapper`. The mount gate keeps the viewport /
 * node subscriptions inside this component scoped to one canvas, not
 * one per node.
 *
 * The current-type drag control precedes formatting, dimensions, and primary
 * actions. Overflow contains conversion, secondary node actions, move, link,
 * and delete commands for every input mode.
 *
 * Positioning, portal-into-body, and viewport clamping are delegated to
 * `CanvasFloatingPopover`.
 */
export const NodeFloatingToolbar = memo(
  ({
    id,
    type,
    data,
    toolbar,
    actions,
    overflow,
    dragEnabled,
    dragActive,
    onDragActiveChange,
  }: NodeFloatingToolbarProps) => {
    const { t } = useTranslation();
    const [moreOpen, setMoreOpen] = useState(false);
    const internalNode = useInternalNode(id);
    // While the node is collapsed to its takeover mark the card has faded
    // out, so the toolbar anchors to the mark instead of hovering above the
    // top edge of an invisible rectangle.
    const mark = useNodeCollapseStore((s) => s.marks[id]);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const canvasId = useCanvasStore((s) => s.canvasId);
    const convertNodeType = useCanvasStore((s) => s.convertNodeType);
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);
    const setMoveSelectionDialogOpen = useCanvasStore(
      (s) => s.setMoveSelectionDialogOpen,
    );
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
      () => translateColorOptions(nodeAccentPickerOptions([type]), t),
      [t, type],
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
    const authoredFont = data.style?.fontSize;
    const questionFont =
      typeof authoredFont === 'number' &&
      Number.isFinite(authoredFont) &&
      authoredFont > 0
        ? authoredFont
        : QUESTION_NODE_DEFAULT_FONT_SIZE;
    const questionScale =
      (questionFont / QUESTION_NODE_DEFAULT_FONT_SIZE) * 100;
    const applyQuestionScale = (percent: number) => {
      const state = useCanvasStore.getState();
      const intent = {
        type: 'SET_QUESTION_CARD_SCALE' as const,
        nodeId: id,
        percent,
      };
      // Preflight against live state: rounded display and stale targets must
      // never create an empty gesture or a second undo entry on blur.
      if (resolveUiIntent(intent, state).commands.length === 0) return;
      state.beginGesture('SET_NODE_GEOMETRY');
      state.dispatchUiIntent(intent);
    };
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
        open={dragActive || !multiSelectModifierHeld}
        offset={nodeToolbarOffset(isNotMouse)}
        side="top"
        className={`${FLOATING_TOOLBAR_CLASS} node-floating-toolbar`}
        onKeyDown={(event) => {
          handleCanvasFocusEscape(event);
          handleCanvasNavigationKey(event);
        }}
      >
        {/* Leading type indicator. */}
        {dragEnabled || type === 'text' || type === 'note' ? (
          <ToolbarTypeButton
            id={id}
            type={type}
            dragEnabled={dragEnabled}
            onActiveChange={onDragActiveChange}
            title={
              type === 'text'
                ? t('layers.filterLabels.text')
                : type === 'note'
                  ? t('layers.filterLabels.note')
                  : undefined
            }
          />
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
            floating
            triggerClassName="node-toolbar-color"
            colors={accentPickerOptions}
            value={nodeAccentPickerValue(type, data.style?.accent)}
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

        {type === 'sketch' && toolbar}
        {type === 'text' && (
          <>
            <TextFontSizePicker
              value={data.style?.fontSize ?? 16}
              onApply={(fontSize) =>
                updateNodeData(id, { style: { ...data.style, fontSize } })
              }
            />
            {toolbar}
            <FloatingToolbar.Divider />
          </>
        )}

        <DropdownMenu
          floating
          placement="bottom"
          className={`${FLOATING_TOOLBAR_POPOVER_CLASS} node-toolbar-size-panel ${type === 'spacePreview' ? '' : 'flex-row items-center gap-2'}`}
          trigger={
            <Button
              variant="ghost"
              iconOnly
              title={t(
                type === 'spacePreview'
                  ? 'spacePreview.widthSettings'
                  : 'toolbar.size.title',
              )}
            >
              <Settings2 />
            </Button>
          }
        >
          {type === 'spacePreview' ? (
            <SpaceShortcutWidthSettings
              key={`${data.type === 'spacePreview' ? data.widthMode : ''}-${currentWidth}`}
              width={currentWidth ?? SPACE_SHORTCUT_SIZE.defaultWidth}
              automatic={
                data.type === 'spacePreview' && data.widthMode === 'auto'
              }
              onChange={(width) => {
                if (width === null) {
                  updateNodeData(id, { widthMode: 'auto' });
                } else {
                  beginGesture('SET_NODE_GEOMETRY');
                  setNodeGeometry([
                    { nodeId: id, size: { width, height: 'auto' } },
                  ]);
                }
              }}
            />
          ) : (
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
                      appearance: 'separate',
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
          {type === 'question' && (
            <FloatingToolbar.NumberInput
              label={t('toolbar.cardScale')}
              ariaLabel={t('toolbar.cardScale')}
              title={t('toolbar.cardScale')}
              name="question-card-scale"
              value={questionScale}
              min={QUESTION_CARD_SCALE_RANGE.min}
              max={QUESTION_CARD_SCALE_RANGE.max}
              inputClassName="w-9"
              endAdornment={
                <span aria-hidden="true" className="text-fg-subtle text-xs">
                  %
                </span>
              }
              onApply={applyQuestionScale}
            />
          )}
        </DropdownMenu>

        {/* ── Group 3: Canvas display effects ── */}
        {type !== 'text' && type !== 'sketch' && toolbar}

        {/* ── Group 4: Actions ── */}
        {actions}

        <FloatingToolbar.Divider />
        <DropdownMenu
          floating
          open={moreOpen}
          onOpenChange={setMoreOpen}
          className="node-toolbar-overflow"
          align="bottom-left"
          trigger={
            <Button variant="ghost" iconOnly title={t('toolbar.more')}>
              <Ellipsis />
            </Button>
          }
        >
          <div
            role="presentation"
            onKeyDown={handleCanvasNavigationKey}
            onClick={(event) => {
              event.stopPropagation();
              const item = (event.target as Element).closest(
                '[role="menuitem"]',
              );
              if (
                item &&
                !item.hasAttribute('aria-haspopup') &&
                !item.hasAttribute('disabled')
              )
                setMoreOpen(false);
            }}
          >
            {(type === 'text' || type === 'note') && (
              <DropdownMenuItem
                disabled={isTypeToggleDisabled}
                title={typeToggleDisabledReason ?? undefined}
                icon={type === 'text' ? <NODE_ICON.note /> : <NODE_ICON.text />}
                onClick={() => {
                  if (!isTypeToggleDisabled)
                    convertNodeType(id, type === 'text' ? 'note' : 'text');
                }}
              >
                {type === 'text'
                  ? t('toolbar.convertToNote')
                  : t('toolbar.convertToText')}
              </DropdownMenuItem>
            )}
            {overflow}
            {type !== 'spacePreview' && (
              <DropdownMenuItem
                icon={<SquareArrowRightEnter />}
                onClick={() => setMoveSelectionDialogOpen(true)}
              >
                {t('moveSelection.action')}
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              icon={<Link />}
              onClick={() => {
                const href = buildNodeDeepLink(
                  window.location.origin,
                  canvasId,
                  id,
                );
                void copyToClipboard(href)
                  .then(() => {
                    toast(t('node.linkCopied'), { tone: 'success' });
                  })
                  .catch(() => {
                    toast(t('node.copyLinkFailed'), { tone: 'danger' });
                  });
              }}
            >
              {t('node.copyLink')}
            </DropdownMenuItem>

            <DropdownMenuItem
              icon={<Trash2 />}
              className="text-danger"
              onClick={() => deleteNodes([id])}
            >
              {t('actions.delete')}
            </DropdownMenuItem>
          </div>
        </DropdownMenu>
      </CanvasFloatingPopover>
    );
  },
);
NodeFloatingToolbar.displayName = 'NodeFloatingToolbar';
