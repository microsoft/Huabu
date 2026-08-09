// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Columns2,
  TableOfContents,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { getNodeIcon } from '@/config/nodeIcons.ts';
import { formatShortcutById, matchesShortcut } from '@/config/shortcuts.ts';

import { InPreviewSearchBar } from './InPreviewSearchBar.tsx';
import {
  getExpandedNodeNeighbors,
  isExpandedNodeNavigationBlocked,
  type ExpandedNodeDirection,
} from './navigation';
import { PreviewSearchAdapterProvider } from './PreviewSearchAdapterContext';
import { useSwipeNavigation } from './swipeNavigation';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useChatStore } from '../../../store/chatStore.ts';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from '../../../store/previewWorkspace/store.ts';
import { Button } from '../../Common/Button.tsx';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu.tsx';
import { Input } from '../../Common/Input.tsx';
import { NodePreviewContent } from '../../Nodes/NodePreviewContent.tsx';
import { PreviewHeaderSlotContext } from '../../Nodes/PreviewHeaderSlot.tsx';

import type { Node } from '@xyflow/react';

/* ------------------------------------------------------------------ */
/*  ExpandedNodePanel – inline panel that replaces or sits beside     */
/*  the canvas.                                 */
/* ------------------------------------------------------------------ */

type ExpandedNodePanelProps = {
  isChatCollapsed?: boolean;
  onToggleChat?: () => void;
};

type ConnectedNodeMenuProps = {
  groups: Array<{
    direction: ExpandedNodeDirection;
    label: string;
    neighbors: Node[];
    shortcut?: string;
  }>;
  open: boolean;
  focusDirection: ExpandedNodeDirection | null;
  title: string;
  menuLabel: string;
  untitledLabel: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (nodeId: string) => void;
};

const ConnectedNodeMenu = ({
  groups,
  open,
  focusDirection,
  title,
  menuLabel,
  untitledLabel,
  onOpenChange,
  onSelect,
}: ConnectedNodeMenuProps) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(open);
  const restoreTriggerFocusRef = useRef(true);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open) {
      if (restoreTriggerFocusRef.current) {
        triggerRef.current?.focus({ preventScroll: true });
      }
      restoreTriggerFocusRef.current = true;
    }
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    );
    if (items.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === 'Home') {
      items[0].focus();
    } else if (event.key === 'End') {
      items.at(-1)?.focus();
    } else {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + delta + items.length) % items.length;
      items[nextIndex].focus();
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      align="bottom-left"
      className="min-w-56"
      trigger={
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          iconOnly
          title={title}
          tooltipPlacement="bottom"
          aria-label={title}
          aria-haspopup="menu"
        >
          <TableOfContents />
        </Button>
      }
    >
      <div
        role="menu"
        tabIndex={-1}
        aria-label={menuLabel}
        onKeyDown={handleMenuKeyDown}
      >
        {groups.map((group, groupIndex) => {
          return (
            <div
              key={group.direction}
              className={clsx(
                groupIndex > 0 && 'border-edge-default mt-1 border-t pt-1',
              )}
            >
              <div className="text-fg-subtle flex items-center justify-between gap-4 px-3 py-1 text-xs font-medium uppercase">
                <span>{group.label}</span>
                {group.shortcut &&
                  (group.direction === 'incoming' ? (
                    <ArrowLeft
                      size={14}
                      strokeWidth={2}
                      className="text-fg-subtle shrink-0"
                      aria-label={group.shortcut}
                    />
                  ) : group.direction === 'outgoing' ? (
                    <ArrowRight
                      size={14}
                      strokeWidth={2}
                      className="text-fg-subtle shrink-0"
                      aria-label={group.shortcut}
                    />
                  ) : (
                    <span className="text-fg-subtle text-xs normal-case">
                      {group.shortcut}
                    </span>
                  ))}
              </div>
              {group.neighbors.map((neighbor, index) => {
                const NodeTypeIcon = getNodeIcon(neighbor.type, neighbor.data);
                const label =
                  typeof neighbor.data.label === 'string' && neighbor.data.label
                    ? neighbor.data.label
                    : untitledLabel;
                return (
                  <DropdownMenuItem
                    key={neighbor.id}
                    icon={<NodeTypeIcon size={13} strokeWidth={1.5} />}
                    autoFocus={
                      group.direction === focusDirection && index === 0
                    }
                    onClick={() => {
                      restoreTriggerFocusRef.current = false;
                      onSelect(neighbor.id);
                    }}
                  >
                    {label}
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </div>
    </DropdownMenu>
  );
};

export const ExpandedNodePanel = ({
  isChatCollapsed,
  onToggleChat,
}: ExpandedNodePanelProps) => {
  const { t } = useTranslation();
  // Canvas Store State
  const expandedNodeId = usePreviewWorkspaceStore(selectActiveNodeId);
  const canvasExpandMode = useCanvasStore((s) => s.expandMode);
  const closeExpandedCanvas = useCanvasStore((s) => s.closeExpanded);
  const setCanvasExpandMode = useCanvasStore((s) => s.setExpandMode);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const openExpandedCanvas = useCanvasStore((s) => s.openExpanded);
  const selectCanvasNodes = useCanvasStore((s) => s.selectNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  // Routed through `tryRename` so a sibling-label collision triggers the
  // shared alert + revert flow (same path used by the layer tree and
  // FrameNode's inline label editor).
  const tryRename = useCanvasStore((s) => s.tryRename);

  const node = useMemo(() => {
    if (!expandedNodeId) return null;
    return nodes.find((n) => n.id === expandedNodeId) ?? null;
  }, [expandedNodeId, nodes]);
  const incomingNeighbors = useMemo(
    () =>
      expandedNodeId
        ? getExpandedNodeNeighbors(nodes, edges, expandedNodeId, 'incoming')
        : [],
    [edges, expandedNodeId, nodes],
  );
  const outgoingNeighbors = useMemo(
    () =>
      expandedNodeId
        ? getExpandedNodeNeighbors(nodes, edges, expandedNodeId, 'outgoing')
        : [],
    [edges, expandedNodeId, nodes],
  );
  const undirectedNeighbors = useMemo(
    () =>
      expandedNodeId
        ? getExpandedNodeNeighbors(nodes, edges, expandedNodeId, 'undirected')
        : [],
    [edges, expandedNodeId, nodes],
  );
  const sourceShortcut = formatShortcutById('node.navigateUpstream');
  const destinationShortcut = formatShortcutById('node.navigateDownstream');
  const connectedNodeGroups = useMemo(
    () =>
      [
        {
          direction: 'incoming' as const,
          label: t('node.sourceNodes'),
          neighbors: incomingNeighbors,
          shortcut: sourceShortcut,
        },
        {
          direction: 'undirected' as const,
          label: t('node.neighborNodes'),
          neighbors: undirectedNeighbors,
        },
        {
          direction: 'outgoing' as const,
          label: t('node.destinationNodes'),
          neighbors: outgoingNeighbors,
          shortcut: destinationShortcut,
        },
      ].filter((group) => group.neighbors.length > 0),
    [
      destinationShortcut,
      incomingNeighbors,
      outgoingNeighbors,
      sourceShortcut,
      t,
      undirectedNeighbors,
    ],
  );
  const [openNeighborDirection, setOpenNeighborDirection] =
    useState<ExpandedNodeDirection | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selectNeighbor = useCallback(
    (nodeId: string) => {
      setOpenNeighborDirection(null);
      // Connected-node navigation browses, so it reuses the group's
      // inspection slot rather than appending a tab (§9.2).
      openExpandedCanvas(nodeId, { transient: true });
      selectCanvasNodes([nodeId]);
      panelRef.current?.focus({ preventScroll: true });
    },
    [openExpandedCanvas, selectCanvasNodes],
  );

  // Shared by the arrow shortcuts and the touch swipe. Returns whether the
  // direction had anywhere to go, so callers can leave the input untouched.
  const navigateDirection = useCallback(
    (direction: ExpandedNodeDirection) => {
      const neighbors =
        direction === 'incoming' ? incomingNeighbors : outgoingNeighbors;
      if (neighbors.length === 0) return false;
      if (neighbors.length === 1) {
        selectNeighbor(neighbors[0].id);
      } else {
        setOpenNeighborDirection(direction);
      }
      return true;
    },
    [incomingNeighbors, outgoingNeighbors, selectNeighbor],
  );

  useEffect(() => {
    setOpenNeighborDirection(null);
  }, [expandedNodeId]);

  const activeItem = useMemo(() => {
    if (!expandedNodeId || !node) return null;
    return {
      type: node.type || 'text',
      data: node.data as Record<string, unknown>,
      expandMode: canvasExpandMode,
      close: closeExpandedCanvas,
      setMode: setCanvasExpandMode,
    };
  }, [
    expandedNodeId,
    node,
    canvasExpandMode,
    closeExpandedCanvas,
    setCanvasExpandMode,
  ]);

  // If the node was removed while expanded, close the panel.
  useEffect(() => {
    if (expandedNodeId && !node) {
      closeExpandedCanvas();
    }
  }, [closeExpandedCanvas, expandedNodeId, node]);

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
        return;
      }
      if (isExpandedNodeNavigationBlocked(e.target)) {
        return;
      }

      const direction = matchesShortcut(e, 'node.navigateUpstream')
        ? 'incoming'
        : matchesShortcut(e, 'node.navigateDownstream')
          ? 'outgoing'
          : null;
      if (!direction) return;

      if (navigateDirection(direction)) e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItem, navigateDirection]);

  // Scroll container of the preview body. Stored in component state
  // (not a plain ref) so that mounting the div triggers a re-render —
  // `InPreviewSearchBar` receives this as a prop and would otherwise
  // be stuck with `null` on first open, since a plain ref update does
  // not propagate to children. Matches the pattern used for
  // `headerSlotEl` below.
  const [previewBodyEl, setPreviewBodyEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Touch equivalent of the upstream/downstream arrow keys. Left off when there
  // is nowhere to go, so isolated nodes keep the browser's fast-path scrolling
  // instead of paying for a non-passive touchmove listener.
  useSwipeNavigation(
    previewBodyEl,
    activeItem && (incomingNeighbors.length > 0 || outgoingNeighbors.length > 0)
      ? navigateDirection
      : undefined,
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
    if (!node) return '';
    return typeof node.data.label === 'string' ? node.data.label : '';
  }, [node]);
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
  }, [expandedNodeId]);

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

  const canEditTitle = !!expandedNodeId;
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
  // in-preview find bar.
  const previewNodeId = expandedNodeId ?? '';

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-search-scope="node"
      data-search-node-id={previewNodeId}
      className="border-edge-default bg-surface flex h-full w-full flex-col overflow-hidden border-l"
    >
      {/* Header bar */}
      <div className="border-edge-default bg-surface flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        {/* Left: node identity and node-specific actions, followed by
            connected-node navigation. Content-sized so short
            labels hug their text — the title region must not stretch,
            otherwise the trailing divider gets pushed far away from
            the action group and the header reads as having a giant
            empty middle. */}
        <div className="flex min-w-0 items-center gap-2">
          {connectedNodeGroups.length > 0 && (
            <ConnectedNodeMenu
              groups={connectedNodeGroups}
              open={openNeighborDirection !== null}
              focusDirection={openNeighborDirection}
              title={t('node.connectedNodeNavigation')}
              menuLabel={t('node.connectedNodeNavigation')}
              untitledLabel={t('node.untitled')}
              onOpenChange={(open) =>
                setOpenNeighborDirection(
                  open
                    ? (openNeighborDirection ??
                        connectedNodeGroups[0].direction)
                    : null,
                )
              }
              onSelect={selectNeighbor}
            />
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
                {...(canEditTitle
                  ? {
                      role: 'button' as const,
                      tabIndex: 0,
                      onClick: () => setIsEditingTitle(true),
                      onKeyDown: (e: ReactKeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setIsEditingTitle(true);
                        }
                      },
                    }
                  : {})}
              >
                {liveLabel || t('node.untitled')}
              </span>
            )}
          </div>
        </div>

        {/* Right: node-specific actions followed by view-level controls. */}
        <div className="text-fg-muted flex items-center gap-1">
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
        <PreviewSearchAdapterProvider>
          {/* In-preview find bar — renders nothing unless search scope
              is `'node'`. Wires the highlight walk to the body element
              (via state-as-ref) so only the visible preview gets
              `::highlight()` ranges. */}
          <InPreviewSearchBar scopeEl={previewBodyEl} nodeId={expandedNodeId} />
          <PreviewHeaderSlotContext.Provider value={headerSlotValue}>
            <NodePreviewContent
              key={expandedNodeId}
              id={expandedNodeId ?? undefined}
              type={activeItem.type}
              data={activeItem.data}
              readOnly={false}
              onDataChange={
                expandedNodeId
                  ? (patch) => updateNodeData(expandedNodeId, patch)
                  : undefined
              }
            />
          </PreviewHeaderSlotContext.Provider>
        </PreviewSearchAdapterProvider>
      </div>
    </div>
  );
};
