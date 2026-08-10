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
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Fragment, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  usePreviewWorkspaceStore,
  type PreviewWorkspaceState,
} from '@/store/previewWorkspace/store';

import { PreviewGroup } from './PreviewGroup';
import { resolveTabDropDestination } from './tabDnd';

/** Keyboard nudge per Arrow press on the separator. */
const RATIO_STEP = 0.05;

const selectWorkspace = (s: PreviewWorkspaceState) => s.workspace;

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
}: {
  /** Collapses the surface, when the host offers that. */
  onCollapse?: () => void;
} = {}) {
  const { t } = useTranslation();
  const workspace = usePreviewWorkspaceStore(selectWorkspace);
  const activateTab = usePreviewWorkspaceStore((s) => s.activateTab);
  const closeTab = usePreviewWorkspaceStore((s) => s.closeTab);
  const promoteTab = usePreviewWorkspaceStore((s) => s.promoteTab);
  const moveTab = usePreviewWorkspaceStore((s) => s.moveTab);
  const setActiveGroup = usePreviewWorkspaceStore((s) => s.setActiveGroup);
  const setSplitRatio = usePreviewWorkspaceStore((s) => s.setSplitRatio);

  const closeWorkspaceTab = (tabId: string) => {
    const isFinalTab =
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs).length ===
      1;
    closeTab(tabId);
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
      if (tab) openPreviewTarget(tab.target, { openToSide: true });
    },
    [openPreviewTarget],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const isSplit = workspace.groups.length > 1;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onTabDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over) return;
      const tabId = String(active.id);
      const destination = resolveTabDropDestination(
        usePreviewWorkspaceStore.getState().workspace,
        tabId,
        String(over.id),
      );
      if (!destination) return;
      moveTab(tabId, destination);
      activateTab(tabId);
    },
    [activateTab, moveTab],
  );

  const onSeparatorPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent) => {
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width === 0) return;
        setSplitRatio((ev.clientX - bounds.left) / bounds.width);
      };
      const up = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
      };

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
    },
    [setSplitRatio],
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
      onDragEnd={onTabDragEnd}
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
                className="group hover:bg-info/30 focus-visible:outline-info flex w-1 shrink-0 cursor-col-resize items-center justify-center focus-visible:outline-1"
              />
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
                isFocused={group.id === workspace.activeGroupId}
                onFocus={() => setActiveGroup(group.id)}
                onActivate={activateTab}
                onClose={closeWorkspaceTab}
                onPromote={promoteTab}
                onOpenToSide={openToSide}
                onCollapse={
                  index === workspace.groups.length - 1 ? onCollapse : undefined
                }
              />
            </div>
          </Fragment>
        ))}
      </div>
    </DndContext>
  );
}
