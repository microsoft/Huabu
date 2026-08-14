// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A preview group's tab strip.
 *
 * Implements the WAI-ARIA tabs pattern with roving focus: exactly one tab is
 * in the tab order, and Arrow keys move focus (and activation) within the
 * strip. Home / End jump to the ends; Delete closes the focused tab.
 *
 * Activation follows focus, which suits a preview surface: arrowing through
 * tabs is how the user browses.
 */

import { useDroppable } from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable';
import {
  Columns2,
  ListIndentIncrease,
  Maximize2,
  Minimize2,
  Plus,
} from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { PreviewTab } from './PreviewTab';
import { groupDropId } from './tabDnd';
import { Button } from '../../Common/Button';

import type { TabDropIndicator } from './tabDnd';
import type { PreviewTab as PreviewTabModel } from '@/store/previewWorkspace/model';

type PreviewTabStripProps = {
  groupId: string;
  tabs: PreviewTabModel[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPromote: (tabId: string) => void;
  /** Moves the active tab into the other group, creating it when absent. */
  onOpenToSide: (tabId: string) => void;
  /** Hidden once both groups exist, since there is no third to open into. */
  canOpenToSide: boolean;
  /** Creates a fresh Chat tab in this group. */
  onNewChat: () => void;
  tabDropIndicator: TabDropIndicator | null;
  isFullscreen: boolean;
  onToggleFullscreen?: () => void;
  /** Collapses the whole surface; only the last group offers it. */
  onCollapse?: () => void;
};

export const tabElementId = (groupId: string, tabId: string) =>
  `preview-tab-${groupId}-${tabId}`;
export const panelElementId = (groupId: string) => `preview-panel-${groupId}`;

export function PreviewTabStrip({
  groupId,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onPromote,
  onOpenToSide,
  canOpenToSide,
  onNewChat,
  tabDropIndicator,
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
}: PreviewTabStripProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({
    id: groupDropId(groupId),
    data: { type: 'preview-group', groupId },
  });
  const isAppendTarget =
    tabDropIndicator?.type === 'group-end' &&
    tabDropIndicator.groupId === groupId;

  useEffect(() => {
    if (!activeTabId) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(tabElementId(groupId, activeTabId))
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTabId, groupId]);

  const focusTab = (tabId: string) => {
    onActivate(tabId);
    // The activated tab becomes the only one in the tab order, so move DOM
    // focus with it or the strip would lose focus entirely.
    requestAnimationFrame(() => {
      document
        .getElementById(tabElementId(groupId, tabId))
        ?.focus({ preventScroll: false });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    if (index < 0) return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      // Wraps, per the ARIA tabs pattern.
      const next = (index + delta + tabs.length) % tabs.length;
      focusTab(tabs[next].id);
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusTab(e.key === 'Home' ? tabs[0].id : tabs[tabs.length - 1].id);
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      onClose(tabs[index].id);
    }
  };

  return (
    <div className="bg-surface after:bg-edge-default relative flex h-9 shrink-0 items-stretch after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-20 after:h-px">
      <div
        ref={setNodeRef}
        role="tablist"
        aria-label={t('preview.tabStrip')}
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        <SortableContext
          items={tabs.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((tab) => (
            <PreviewTab
              key={tab.id}
              tab={tab}
              groupId={groupId}
              isActive={tab.id === activeTabId}
              tabElementId={tabElementId(groupId, tab.id)}
              panelElementId={panelElementId(groupId)}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onPromote={() => onPromote(tab.id)}
              onNavigate={handleKeyDown}
              dropIndicatorEdge={
                tabDropIndicator?.type === 'tab' &&
                tabDropIndicator.tabId === tab.id
                  ? tabDropIndicator.edge
                  : undefined
              }
            />
          ))}
        </SortableContext>
        {isAppendTarget && (
          <div
            data-testid="preview-tab-append-indicator"
            className="bg-info my-1 w-0.5 shrink-0 rounded-full"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center px-1">
        <Button
          variant="ghost"
          iconOnly
          size="md"
          title={t('chat.newConversation')}
          tooltipPlacement="bottom"
          onClick={onNewChat}
        >
          <Plus />
        </Button>
        {onToggleFullscreen && (
          <Button
            variant="ghost"
            iconOnly
            size="md"
            data-testid="toggle-preview-fullscreen"
            title={t(
              isFullscreen
                ? 'preview.exitFullscreen'
                : 'preview.enterFullscreen',
            )}
            tooltipPlacement="bottom"
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
        {(canOpenToSide || onCollapse) && (
          <>
            {canOpenToSide && activeTabId && (
              <Button
                variant="ghost"
                iconOnly
                size="md"
                title={t('preview.openToSide')}
                tooltipPlacement="bottom"
                onClick={() => onOpenToSide(activeTabId)}
              >
                <Columns2 />
              </Button>
            )}
            {onCollapse && (
              <Button
                variant="ghost"
                iconOnly
                size="md"
                data-testid="collapse-preview"
                title={t('preview.collapse')}
                tooltipPlacement="bottom"
                onClick={onCollapse}
              >
                <ListIndentIncrease size={16} />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
