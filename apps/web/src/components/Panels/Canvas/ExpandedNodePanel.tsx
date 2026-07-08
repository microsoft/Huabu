import clsx from 'clsx';
import { ArrowLeft, Bot, Columns2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import useCanvasStore from '../../../store/canvasStore.ts';
import { useChatStore } from '../../../store/chatStore.ts';
import { usePreviewStore } from '../../../store/previewStore.ts';
import { Button } from '../../Common/Button.tsx';
import { Input } from '../../Common/Input.tsx';
import { NodePreviewContent } from '../../Nodes/NodePreviewContent.tsx';
import { PreviewHeaderSlotContext } from '../../Nodes/PreviewHeaderSlot.tsx';
import { InPreviewSearchBar } from '../../Search/InPreviewSearchBar.tsx';

/* ------------------------------------------------------------------ */
/*  ExpandedNodePanel – inline panel that replaces or sits beside     */
/*  the canvas.                                 */
/* ------------------------------------------------------------------ */

type ExpandedNodePanelProps = {
  isChatCollapsed?: boolean;
  onToggleChat?: () => void;
};

export const ExpandedNodePanel = ({
  isChatCollapsed,
  onToggleChat,
}: ExpandedNodePanelProps) => {
  const { t } = useTranslation();
  // Canvas Store State
  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const canvasExpandMode = useCanvasStore((s) => s.expandMode);
  const closeExpandedCanvas = useCanvasStore((s) => s.closeExpanded);
  const setCanvasExpandMode = useCanvasStore((s) => s.setExpandMode);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  // Routed through `tryRename` so a sibling-label collision triggers the
  // shared alert + revert flow (same path used by the layer tree and
  // FrameNode's inline label editor).
  const tryRename = useCanvasStore((s) => s.tryRename);

  // Preview Store State
  const previewType = usePreviewStore((s) => s.previewType);
  const previewData = usePreviewStore((s) => s.previewData);
  const closePreview = usePreviewStore((s) => s.closePreview);
  const previewExpandMode = usePreviewStore((s) => s.expandMode);
  const setPreviewExpandMode = usePreviewStore((s) => s.setExpandMode);

  const node = useMemo(() => {
    if (!expandedNodeId) return null;
    return nodes.find((n) => n.id === expandedNodeId) ?? null;
  }, [expandedNodeId, nodes]);

  // Priority: Preview > Node
  // If preview is open, show it. Otherwise show node (if any).
  const isPreview = !!(previewType && previewData);
  const isNode = !!(expandedNodeId && node);

  // Handling conflicts:
  // If preview is newly opened, we want to ensure canvas expand is closed?
  // Probably better handled at the trigger site (the component that opens
  // the preview). Here we just render based on priority.

  const activeItem = useMemo(() => {
    if (isPreview && previewType && previewData) {
      return {
        type: previewType,
        data: previewData,
        readOnly: true,
        isNode: false,
        expandMode: previewExpandMode,
        close: closePreview,
        setMode: setPreviewExpandMode,
      };
    }
    if (isNode && node) {
      return {
        type: node.type || 'text',
        data: node.data as Record<string, unknown>,
        readOnly: false,
        isNode: true,
        expandMode: canvasExpandMode,
        close: closeExpandedCanvas,
        setMode: setCanvasExpandMode,
      };
    }
    return null;
  }, [
    isPreview,
    previewType,
    previewData,
    previewExpandMode,
    closePreview,
    setPreviewExpandMode,
    isNode,
    node,
    canvasExpandMode,
    closeExpandedCanvas,
    setCanvasExpandMode,
  ]);

  // If the node was removed while expanded, close the panel.
  useEffect(() => {
    if (expandedNodeId && !node && !isPreview) {
      closeExpandedCanvas();
    }
  }, [closeExpandedCanvas, expandedNodeId, node, isPreview]);

  // Global Escape key handler.
  // Bubble phase (no capture flag) so child components (e.g. inline editor menus)
  // can call stopPropagation() to handle Escape themselves without closing the
  // panel. Note: Escape inside a cross-origin iframe won't reach this handler
  // due to browser security boundaries – that's an acceptable limitation.
  useEffect(() => {
    if (!activeItem) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        activeItem.close();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItem]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Scroll container of the preview body. Stored in component state
  // (not a plain ref) so that mounting the div triggers a re-render —
  // `InPreviewSearchBar` receives this as a prop and would otherwise
  // be stuck with `null` on first open, since a plain ref update does
  // not propagate to children. Matches the pattern used for
  // `headerSlotEl` below.
  const [previewBodyEl, setPreviewBodyEl] = useState<HTMLDivElement | null>(
    null,
  );
  const setSelectionAttachment = useChatStore((s) => s.setSelectionAttachment);

  // Slot element rendered in the header bar. Nested previews use the
  // `PreviewHeaderSlot` context + `createPortal` to render their own
  // action buttons here. `useState` (instead of a plain ref) gives us
  // a re-render once the element mounts so portal consumers wake up.
  // Portalled buttons are responsible for setting their own
  // `tooltipPlacement="bottom"` — the header sits flush against the top
  // of the panel, so the default `'top'` tooltip would escape upward.
  const [headerSlotEl, setHeaderSlotEl] = useState<HTMLDivElement | null>(null);
  const headerSlotValue = useMemo(() => ({ el: headerSlotEl }), [headerSlotEl]);

  // ─── Inline title editor ─────────────────────────────────────────
  // Single source of truth for the displayed label, regardless of
  // whether the surface is a canvas-node (editable) or a preview
  // (read-only). Effects below sync the draft to the live label
  // whenever we're not actively editing — covers external renames
  // (e.g. via the layer tree) and switches between expanded nodes.
  const liveLabel = useMemo(() => {
    if (isPreview && previewData)
      return typeof previewData.label === 'string' ? previewData.label : '';
    if (isNode && node)
      return typeof node.data.label === 'string' ? node.data.label : '';
    return '';
  }, [isPreview, previewData, isNode, node]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(liveLabel);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingTitle) return;
    setDraftTitle(liveLabel);
  }, [liveLabel, isEditingTitle]);

  useEffect(() => {
    if (!isEditingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle]);

  // Always exit edit mode when the underlying expanded item changes,
  // so an unsubmitted draft never leaks onto the next node's title.
  useEffect(() => {
    setIsEditingTitle(false);
  }, [expandedNodeId, previewType]);

  // Listen for text selection inside the panel and auto-attach as pending
  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();

    // If selection is collapsed (e.g. user clicked elsewhere like chat input),
    // only clear if the focus is still inside this panel — otherwise keep the
    // attachment so the user can type in chat input without losing it.
    if (!sel || sel.isCollapsed || !panelRef.current) {
      const active = document.activeElement;
      if (active && panelRef.current?.contains(active)) {
        setSelectionAttachment(null);
      }
      return;
    }

    // Check that the selection is inside this panel
    const anchor = sel.anchorNode;
    if (!anchor || !panelRef.current.contains(anchor)) {
      return;
    }

    const text = sel.toString().trim();
    if (!text) {
      setSelectionAttachment(null);
      return;
    }

    setSelectionAttachment({
      type: 'text',
      source: 'excerpt',
      originNodeId: expandedNodeId ?? undefined,
      content: text,
      label: text.length > 12 ? text.slice(0, 12) + '…' : text,
    });
  }, [setSelectionAttachment, expandedNodeId]);

  useEffect(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      // Clear selection attachment when panel unmounts or item changes
      useChatStore.getState().setSelectionAttachment(null);
    };
  }, [handleSelectionChange]);

  if (!activeItem) return null;

  const isReplace = activeItem.expandMode === 'replace';

  const backTitle = activeItem.isNode ? 'Back to Canvas' : 'Close Preview';

  // Inline rename is available only when the panel is hosting a real
  // canvas node (previews are intentionally read-only).
  const canEditTitle = activeItem.isNode && !!expandedNodeId;
  const commitTitle = () => {
    if (!canEditTitle || !expandedNodeId) {
      setIsEditingTitle(false);
      setDraftTitle(liveLabel);
      return;
    }
    const next = draftTitle.trim();
    if (!next || next === liveLabel.trim()) {
      setIsEditingTitle(false);
      setDraftTitle(liveLabel);
      return;
    }
    void tryRename('node', expandedNodeId, next).then((ok) => {
      if (!ok) setDraftTitle(liveLabel);
    });
    setIsEditingTitle(false);
  };

  // Search node id — the find bar's scope dispatcher (see
  // `useGlobalSearchHotkey`) requires a non-empty value to open the
  // in-preview find bar. Canvas-node previews always have one;
  // free-floating previews (e.g. raw file preview) may not, in which
  // case `previewNodeId` falls back to `''` and Cmd+F routes to the
  // canvas-wide search overlay instead of the in-preview bar.
  const previewNodeId = (() => {
    if (activeItem.isNode && expandedNodeId) return expandedNodeId;
    const id = previewData?.nodeId;
    return typeof id === 'string' ? id : '';
  })();

  return (
    <div
      ref={panelRef}
      data-search-scope="node"
      data-search-node-id={previewNodeId}
      className="border-edge-default bg-surface flex h-full w-full flex-col overflow-hidden border-l"
    >
      {/* Header bar */}
      <div className="border-edge-default bg-surface flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        {/* Left: back button (replace mode) + title (inline-editable for
            node mode, read-only for previews). Content-sized so short
            labels hug their text — the title region must not stretch,
            otherwise the trailing divider gets pushed far away from
            the action group and the header reads as having a giant
            empty middle. */}
        <div className="flex min-w-0 items-center gap-2">
          {isReplace && (
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={backTitle}
              tooltipPlacement="bottom"
              onClick={activeItem.close}
            >
              <ArrowLeft />
            </Button>
          )}

          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            {canEditTitle && isEditingTitle ? (
              <Input
                ref={titleInputRef}
                value={draftTitle}
                placeholder={t('node.untitled')}
                wrapperClassName="min-w-0"
                className="text-fg-default bg-bg-default border-edge-default w-64 max-w-lg min-w-0 truncate rounded border px-1 py-0.5 text-sm font-medium outline-none"
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  // Keep keystrokes (notably Escape) from reaching the
                  // window-level Escape handler that closes the panel.
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTitle();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setDraftTitle(liveLabel);
                    setIsEditingTitle(false);
                  }
                }}
              />
            ) : (
              <span
                className={clsx(
                  'text-fg-muted max-w-lg truncate rounded border border-transparent px-1 py-0.5',
                  canEditTitle && 'hover:text-fg-default cursor-text',
                )}
                title={canEditTitle ? t('node.rename') : undefined}
                role={canEditTitle ? 'button' : undefined}
                tabIndex={canEditTitle ? 0 : undefined}
                onClick={() => {
                  if (canEditTitle) setIsEditingTitle(true);
                }}
                onKeyDown={(e) => {
                  if (!canEditTitle) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setIsEditingTitle(true);
                  }
                }}
              >
                {liveLabel || t('node.untitled')}
              </span>
            )}
            {activeItem.readOnly && (
              <span className="bg-bg-default text-fg-muted rounded px-1.5 py-0.5 text-xs uppercase">
                {t('node.preview')}
              </span>
            )}
          </div>
        </div>

        {/* Right: mode toggle + close */}
        <div className="text-fg-muted flex items-center gap-1">
          {/* Divider separating the title region from the action group
              so the header reads as two clear zones (identity ↔
              actions). Always visible — even a bare preview still has
              the universal mode-toggle + close buttons on this side.
              Padding matches the inner header-slot divider below so
              the spacing rhythm reads as a single coherent grid. */}
          <div aria-hidden="true" className="bg-edge-default mx-1 h-5 w-px" />
          {/* Per-preview action slot (filled via portal by NotePreview
              and friends). Sits to the LEFT of the universal Bot /
              mode / close buttons so preview-specific controls feel
              like first-class header actions while remaining visually
              grouped on their own. The trailing divider is
              auto-hidden via `peer-empty:hidden` when the slot has
              no contributed actions, so we never render a stray
              vertical line. */}
          <div
            ref={setHeaderSlotEl}
            className="peer flex items-center gap-1 empty:hidden"
          />
          <div
            aria-hidden="true"
            className="bg-edge-default mx-1 h-5 w-px peer-empty:hidden"
          />

          {isReplace && onToggleChat && (
            <Button
              variant="ghost"
              iconOnly
              size="md"
              className={
                !isChatCollapsed
                  ? 'text-info bg-info-bg enabled:hover:bg-info-bg-hover'
                  : ''
              }
              title={isChatCollapsed ? t('chat.open') : t('chat.close')}
              tooltipPlacement="bottom"
              aria-label={
                isChatCollapsed ? t('chat.openPanel') : t('chat.closePanel')
              }
              aria-pressed={!isChatCollapsed}
              onClick={onToggleChat}
            >
              <Bot />
            </Button>
          )}

          <Button
            variant="ghost"
            iconOnly
            size="sm"
            className={!isReplace ? 'text-fg-default bg-bg-default' : ''}
            title={isReplace ? t('node.splitView') : t('node.fullView')}
            tooltipPlacement="bottom"
            onClick={() => activeItem.setMode(isReplace ? 'split' : 'replace')}
          >
            <Columns2 />
          </Button>

          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title={t('actions.close')}
            tooltipPlacement="bottom"
            onClick={(e) => {
              e.stopPropagation();
              activeItem.close();
            }}
          >
            <X />
          </Button>
        </div>
      </div>

      {/* Content. `relative` anchors the floating in-preview find
          bar (Cmd+F) to the top-right of this body — keeps the
          preview document underneath fully visible instead of
          pushing it down with an inline find row. */}
      <div ref={setPreviewBodyEl} className="relative flex-1 overflow-hidden">
        {/* In-preview find bar — renders nothing unless search scope
            is `'node'`. Wires the highlight walk to the body element
            (via state-as-ref) so only the visible preview gets
            `::highlight()` ranges. */}
        <InPreviewSearchBar scopeEl={previewBodyEl} />
        <PreviewHeaderSlotContext.Provider value={headerSlotValue}>
          <NodePreviewContent
            key={expandedNodeId ?? previewType}
            id={expandedNodeId ?? undefined}
            type={activeItem.type}
            data={activeItem.data}
            readOnly={activeItem.readOnly}
            onDataChange={
              activeItem.isNode && expandedNodeId
                ? (patch) => updateNodeData(expandedNodeId, patch)
                : undefined
            }
          />
        </PreviewHeaderSlotContext.Provider>
      </div>
    </div>
  );
};
