// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The tabbed, optionally split preview surface.
 *
 * Renders at most two horizontally arranged groups (§9). The separator is
 * both pointer-draggable and keyboard-operable; the ratio is clamped by the
 * model so neither group can be dragged to uselessness.
 */

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type PointerSensorProps,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import useCanvasStore, { settleNodePreprocess } from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { conversationViewForNode } from '@/store/conversationOwner';
import {
  messageListViewKey,
  nodePreviewViewKey,
  reconcilePreviewScrollTargets,
} from '@/store/previewWorkspace/scrollMemory';
import {
  usePreviewWorkspaceStore,
  type PreviewWorkspaceState,
} from '@/store/previewWorkspace/store';

import { PreviewGroup } from './PreviewGroup';
import { PreviewTabDragOverlay } from './PreviewTab';
import { resolveTabDropDestination, resolveTabDropIndicator } from './tabDnd';

import type {
  CanvasPreviewWorkspace,
  PreviewTarget,
} from '@/store/previewWorkspace/model';
import type { Node } from '@xyflow/react';

/** Keyboard nudge per Arrow press on the separator. */
const RATIO_STEP = 0.05;

const selectWorkspace = (s: PreviewWorkspaceState) => s.workspace;

export function subscribeToTabDragInterruption(
  cancel: () => void,
  ownerDocument: Document = document,
  ownerWindow: Window = window,
): () => void {
  const cancelOnHidden = () => {
    if (ownerDocument.visibilityState === 'hidden') cancel();
  };
  ownerWindow.addEventListener('blur', cancel);
  ownerDocument.addEventListener('visibilitychange', cancelOnHidden);
  return () => {
    ownerWindow.removeEventListener('blur', cancel);
    ownerDocument.removeEventListener('visibilitychange', cancelOnHidden);
  };
}

class PreviewTabPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    let unsubscribe = () => {};
    const onCancel = () => {
      unsubscribe();
      props.onCancel();
    };
    const onEnd = () => {
      unsubscribe();
      props.onEnd();
    };
    const onAbort = (id: Parameters<PointerSensorProps['onAbort']>[0]) => {
      unsubscribe();
      props.onAbort(id);
    };

    super({ ...props, onAbort, onCancel, onEnd });

    const ownerDocument =
      (
        props.event.target as
          | (EventTarget & { ownerDocument?: Document })
          | null
      )?.ownerDocument ?? document;
    unsubscribe = subscribeToTabDragInterruption(
      onCancel,
      ownerDocument,
      ownerDocument.defaultView ?? window,
    );
  }
}

export function PreviewTabDragOverlayPortal({
  tab,
}: {
  tab: CanvasPreviewWorkspace['tabs'][string] | undefined;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="contents" data-testid="preview-tab-drag-portal">
      <DragOverlay dropAnimation={null}>
        {tab ? <PreviewTabDragOverlay tab={tab} /> : null}
      </DragOverlay>
    </div>,
    document.body,
  );
}

export function settleActivePreviewTab(
  workspace: CanvasPreviewWorkspace,
  nodes: readonly Node[],
  tabId: string,
  settle: (nodeId: string) => void = settleNodePreprocess,
): void {
  const group = workspace.groups.find((candidate) =>
    candidate.tabIds.includes(tabId),
  );
  if (group?.activeTabId !== tabId) return;

  const target = workspace.tabs[tabId]?.target;
  if (target?.kind !== 'node') return;
  const node = nodes.find((candidate) => candidate.id === target.nodeId);
  if (node?.type === 'note' || node?.type === 'text') settle(node.id);
}

const tabCollisionDetection: CollisionDetection = (args) => {
  const tabContainers = args.droppableContainers.filter(
    (container) => container.data.current?.type === 'preview-tab',
  );

  if (args.pointerCoordinates) {
    const pointerCollisions = pointerWithin(args);
    const tabCollision = pointerCollisions.find((collision) =>
      tabContainers.some((container) => container.id === collision.id),
    );
    return tabCollision ? [tabCollision] : pointerCollisions;
  }

  return closestCenter({ ...args, droppableContainers: tabContainers });
};

export function PreviewWorkspace({
  onCollapse,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  /** Collapses the surface, when the host offers that. */
  onCollapse?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
} = {}) {
  const { t } = useTranslation();
  const workspace = usePreviewWorkspaceStore(selectWorkspace);
  const canvasId = usePreviewWorkspaceStore((s) => s.canvasId);
  const nodeFocusRequest = usePreviewWorkspaceStore((s) => s.nodeFocusRequest);
  const chatOpenRequest = usePreviewWorkspaceStore((s) => s.chatOpenRequest);
  const consumeNodeFocusRequest = usePreviewWorkspaceStore(
    (s) => s.consumeNodeFocusRequest,
  );
  const consumeChatOpenRequest = usePreviewWorkspaceStore(
    (s) => s.consumeChatOpenRequest,
  );
  const activateTab = usePreviewWorkspaceStore((s) => s.activateTab);
  const closeTab = usePreviewWorkspaceStore((s) => s.closeTab);
  const promoteTab = usePreviewWorkspaceStore((s) => s.promoteTab);
  const moveTab = usePreviewWorkspaceStore((s) => s.moveTab);
  const setActiveGroup = usePreviewWorkspaceStore((s) => s.setActiveGroup);
  const setSplitRatio = usePreviewWorkspaceStore((s) => s.setSplitRatio);

  const scrollTargets = useMemo(
    () => Object.values(workspace.tabs).map(({ target }) => target),
    [workspace.tabs],
  );
  const scrollViewKeys = useCanvasStore(
    useShallow((state) =>
      scrollTargets.map((target) => {
        if (target.kind === 'chat') {
          return messageListViewKey(target.canvasId, target.threadId);
        }

        const node = state.nodes.find(
          (candidate) => candidate.id === target.nodeId,
        );
        if (!node) return undefined;
        const view = conversationViewForNode(
          node,
          target.canvasId,
          state.worldReferences[target.nodeId],
        );
        return view
          ? messageListViewKey(
              view.conversationOwner.canvasId,
              view.conversationOwner.threadId,
            )
          : nodePreviewViewKey(target.canvasId, target.nodeId);
      }),
    ),
  );
  const scrollRegistrations = useMemo(() => {
    const registrations: Array<{
      target: PreviewTarget;
      viewKey: string;
    }> = [];
    for (const [index, target] of scrollTargets.entries()) {
      const viewKey = scrollViewKeys[index];
      if (viewKey) registrations.push({ target, viewKey });
    }
    return registrations;
  }, [scrollTargets, scrollViewKeys]);

  useEffect(() => {
    reconcilePreviewScrollTargets(canvasId, scrollRegistrations);
  }, [canvasId, scrollRegistrations]);

  const settleTab = useCallback((tabId: string) => {
    settleActivePreviewTab(
      usePreviewWorkspaceStore.getState().workspace,
      useCanvasStore.getState().nodes,
      tabId,
    );
  }, []);

  const activateWorkspaceTab = useCallback(
    (tabId: string) => {
      const current = usePreviewWorkspaceStore.getState().workspace;
      const group = current.groups.find((candidate) =>
        candidate.tabIds.includes(tabId),
      );
      if (group?.activeTabId && group.activeTabId !== tabId) {
        settleTab(group.activeTabId);
      }
      activateTab(tabId);
    },
    [activateTab, settleTab],
  );

  const closeWorkspaceTab = (tabId: string) => {
    const currentWorkspace = usePreviewWorkspaceStore.getState().workspace;
    const isFinalTab = Object.keys(currentWorkspace.tabs).length === 1;
    closeTab(tabId, settleTab);
    if (isFinalTab) onCollapse?.();
  };
  const openPreviewTarget = usePreviewWorkspaceStore(
    (s) => s.openPreviewTarget,
  );

  const openToSide = useCallback(
    (tabId: string) => {
      const tab = usePreviewWorkspaceStore.getState().workspace.tabs[tabId];
      // Open to Side relocates the one tab rather than duplicating the
      // target, so it goes through the same open path (§8).
      if (tab) {
        settleTab(tabId);
        openPreviewTarget(
          tab.target,
          {
            openToSide: true,
            transient: tab.transient,
          },
          settleTab,
        );
      }
    },
    [openPreviewTarget, settleTab],
  );

  const openNewChat = useCallback(
    (groupId: string) => {
      if (!canvasId) return;
      const threadId = useChatStore.getState().createThread();
      const activeTabId = usePreviewWorkspaceStore
        .getState()
        .workspace.groups.find((group) => group.id === groupId)?.activeTabId;
      if (activeTabId) settleTab(activeTabId);
      openPreviewTarget({ kind: 'chat', canvasId, threadId }, { groupId });
    },
    [canvasId, openPreviewTarget, settleTab],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const separatorDragCleanupRef = useRef<(() => void) | null>(null);
  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const isSplit = workspace.groups.length > 1;
  const sensors = useSensors(
    useSensor(PreviewTabPointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const clearTabDrag = useCallback(() => {
    setActiveDragTabId(null);
    setDragOverId(null);
  }, []);

  const onTabDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveDragTabId(String(active.id));
  }, []);

  const onTabDragOver = useCallback(({ over }: DragOverEvent) => {
    setDragOverId(over ? String(over.id) : null);
  }, []);

  const onTabDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      clearTabDrag();
      if (!over) return;
      const tabId = String(active.id);
      const destination = resolveTabDropDestination(
        usePreviewWorkspaceStore.getState().workspace,
        tabId,
        String(over.id),
      );
      if (!destination) return;
      settleTab(tabId);
      moveTab(tabId, destination, settleTab);
      activateTab(tabId);
    },
    [activateTab, clearTabDrag, moveTab, settleTab],
  );

  const activeDragTab = activeDragTabId
    ? workspace.tabs[activeDragTabId]
    : undefined;
  const tabDropIndicator = resolveTabDropIndicator(
    workspace,
    activeDragTabId,
    dragOverId,
  );

  const onSeparatorPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      separatorDragCleanupRef.current?.();
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      target.setPointerCapture(pointerId);

      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width === 0) return;
        setSplitRatio((ev.clientX - bounds.left) / bounds.width);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (separatorDragCleanupRef.current === cleanup) {
          separatorDragCleanupRef.current = null;
        }
      };
      const finish = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        cleanup();
      };

      separatorDragCleanupRef.current = cleanup;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [setSplitRatio],
  );

  useEffect(
    () => () => {
      separatorDragCleanupRef.current?.();
    },
    [],
  );

  const onSeparatorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? -RATIO_STEP : RATIO_STEP;
    // Read through the store rather than the render-time value: a held or
    // rapidly repeated key fires several times before React re-renders, and
    // a closed-over ratio would make every one of them a no-op after the
    // first.
    const current = usePreviewWorkspaceStore.getState().workspace.splitRatio;
    setSplitRatio(current + delta);
  };

  if (workspace.groups.every((g) => g.tabIds.length === 0)) {
    return (
      <div className="text-fg-subtle flex h-full items-center justify-center p-6 text-center text-sm">
        {t('preview.emptyWorkspace')}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={tabCollisionDetection}
      onDragStart={onTabDragStart}
      onDragOver={onTabDragOver}
      onDragEnd={onTabDragEnd}
      onDragCancel={clearTabDrag}
    >
      <div ref={containerRef} className="flex h-full w-full overflow-hidden">
        {workspace.groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && (
              /*
               * Keyboard-movable pane divider (§9). `jsx-a11y` treats
               * `separator` as non-interactive even when focusable, so the key
               * handler needs an exemption; the matching `tabIndex` allowance
               * is configured repo-wide in `eslint.config.mjs`.
               */
              /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('preview.resizeGroups')}
                aria-valuenow={Math.round(workspace.splitRatio * 100)}
                aria-valuemin={20}
                aria-valuemax={80}
                tabIndex={0}
                onPointerDown={onSeparatorPointerDown}
                onKeyDown={onSeparatorKeyDown}
                className="group focus-visible:outline-info z-10 -mx-1 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center focus-visible:outline-1"
              >
                <div className="bg-edge-default group-hover:bg-info h-full w-px" />
              </div>
            )}
            <div
              className="flex h-full min-w-0 flex-col"
              style={{
                width: isSplit
                  ? `${(index === 0 ? workspace.splitRatio : 1 - workspace.splitRatio) * 100}%`
                  : '100%',
              }}
            >
              <PreviewGroup
                group={group}
                workspace={workspace}
                adjacentNodeTarget={
                  isSplit
                    ? (() => {
                        const otherGroup = workspace.groups[1 - index];
                        const otherTarget = otherGroup?.activeTabId
                          ? workspace.tabs[otherGroup.activeTabId]?.target
                          : undefined;
                        return otherTarget?.kind === 'node'
                          ? otherTarget
                          : undefined;
                      })()
                    : undefined
                }
                isFocused={group.id === workspace.activeGroupId}
                onFocus={() => setActiveGroup(group.id)}
                onActivate={activateWorkspaceTab}
                onClose={closeWorkspaceTab}
                onPromote={promoteTab}
                nodeFocusRequest={nodeFocusRequest}
                onNodeFocusRequestHandled={consumeNodeFocusRequest}
                chatOpenRequest={chatOpenRequest}
                onChatOpenRequestHandled={consumeChatOpenRequest}
                onOpenToSide={openToSide}
                onNewChat={() => openNewChat(group.id)}
                tabDropIndicator={tabDropIndicator}
                isFullscreen={isFullscreen}
                onToggleFullscreen={
                  index === workspace.groups.length - 1
                    ? onToggleFullscreen
                    : undefined
                }
                onCollapse={
                  index === workspace.groups.length - 1 ? onCollapse : undefined
                }
              />
            </div>
          </Fragment>
        ))}
      </div>
      <PreviewTabDragOverlayPortal tab={activeDragTab} />
    </DndContext>
  );
}
