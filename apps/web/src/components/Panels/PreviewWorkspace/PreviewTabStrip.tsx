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
  Maximize,
  Minimize,
  PanelRightClose,
  Plus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { PreviewTab } from './PreviewTab';
import { groupDropId } from './tabDnd';
import { Button } from '../../Common/Button';

import type { TabDropIndicator } from './tabDnd';
import type { AcpConnectionInfo } from '../ChatPanel/AcpConnectionBadge';
import type {
  ClosePreviewTabsScope,
  PreviewTab as PreviewTabModel,
} from '@/store/previewWorkspace/model';

import './previewTabStrip.css';

type PreviewTabStripProps = {
  groupId: string;
  tabs: PreviewTabModel[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseTabs?: (tabId: string, scope: ClosePreviewTabsScope) => void;
  onPromote: (tabId: string) => void;
  onRename?: (tabId: string) => void;
  onTitleEditorHostChange?: (element: HTMLSpanElement | null) => void;
  activeChatConnection?: AcpConnectionInfo;
  onSplit?: () => void;
  onCloseEmptyGroup?: () => void;
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
export const newChatElementId = (groupId: string) =>
  `preview-new-chat-${groupId}`;

export function PreviewTabStrip({
  groupId,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseTabs,
  onPromote,
  onRename,
  onTitleEditorHostChange,
  activeChatConnection,
  onSplit,
  onCloseEmptyGroup,
  onNewChat,
  tabDropIndicator,
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
}: PreviewTabStripProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({
    id: groupDropId(groupId),
    data: { type: 'preview-group', groupId, isEmpty: tabs.length === 0 },
  });
  const stripRef = useRef<HTMLDivElement | null>(null);
  const setStripRef = useCallback(
    (element: HTMLDivElement | null) => {
      stripRef.current = element;
      setNodeRef(element);
    },
    [setNodeRef],
  );
  const isAppendTarget =
    tabDropIndicator?.type === 'group-end' &&
    tabDropIndicator.groupId === groupId;

  useEffect(() => {
    const strip = stripRef.current;
    const activeTab = activeTabId
      ? document.getElementById(tabElementId(groupId, activeTabId))
      : null;
    if (!strip || !activeTab) return;
    let frame = 0;
    const revealActiveTab = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(strip);
    observer.observe(activeTab);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeTabId, groupId]);

  const focusTab = (tabId: string) => {
    onActivate(tabId);
    // The activated tab becomes the only one in the tab order, so move DOM
    // focus with it or the strip would lose focus entirely.
    requestAnimationFrame(() => {
      const tab = document.getElementById(tabElementId(groupId, tabId));
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Let the native scroll settle before focus opens the tab's tooltip.
      requestAnimationFrame(() => tab?.focus({ preventScroll: true }));
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
    <div className="bg-surface after:bg-edge-default relative flex h-11 shrink-0 items-stretch after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px">
      <div
        ref={setStripRef}
        role="tablist"
        aria-label={t('preview.tabStrip')}
        aria-orientation="horizontal"
        className="preview-tab-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden px-2"
      >
        <SortableContext
          items={tabs.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((tab, index) => (
            <PreviewTab
              key={tab.id}
              tab={tab}
              groupId={groupId}
              isActive={tab.id === activeTabId}
              chatConnection={
                tab.id === activeTabId ? activeChatConnection : undefined
              }
              tabElementId={tabElementId(groupId, tab.id)}
              panelElementId={panelElementId(groupId)}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onCloseOthers={
                onCloseTabs && tabs.length > 1
                  ? () => onCloseTabs(tab.id, 'others')
                  : undefined
              }
              onCloseToRight={
                onCloseTabs && index < tabs.length - 1
                  ? () => onCloseTabs(tab.id, 'to-right')
                  : undefined
              }
              onCloseGroup={
                onCloseTabs ? () => onCloseTabs(tab.id, 'group') : undefined
              }
              onPromote={() => onPromote(tab.id)}
              onRename={onRename ? () => onRename(tab.id) : undefined}
              onTitleEditorHostChange={
                tab.id === activeTabId ? onTitleEditorHostChange : undefined
              }
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
      <div className="flex shrink-0 items-center pr-2">
        <Button
          id={newChatElementId(groupId)}
          variant="ghost"
          iconOnly
          size="md"
          className="text-fg-subtle enabled:hover:text-fg-default"
          title={t('chat.newConversation')}
          tooltipPlacement="bottom"
          onClick={onNewChat}
        >
          <Plus aria-hidden />
        </Button>
        {onToggleFullscreen && (
          <Button
            variant="ghost"
            iconOnly
            size="md"
            className="text-fg-subtle enabled:hover:text-fg-default"
            data-testid="toggle-preview-fullscreen"
            title={t(
              isFullscreen
                ? 'preview.exitFullscreen'
                : 'preview.enterFullscreen',
            )}
            tooltipPlacement="bottom"
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize /> : <Maximize />}
          </Button>
        )}
        {onSplit && (
          <Button
            variant="ghost"
            iconOnly
            size="md"
            className="text-fg-subtle enabled:hover:text-fg-default"
            title={t('preview.splitGroup')}
            tooltipPlacement="bottom"
            onClick={onSplit}
          >
            <Columns2 aria-hidden />
          </Button>
        )}
        {onCloseEmptyGroup && (
          <Button
            variant="ghost"
            iconOnly
            size="md"
            className="text-fg-subtle enabled:hover:text-fg-default"
            title={t('preview.closeEmptyGroup')}
            tooltipPlacement="bottom"
            onClick={onCloseEmptyGroup}
          >
            <X aria-hidden />
          </Button>
        )}
        {onCollapse && (
          <Button
            variant="ghost"
            iconOnly
            size="md"
            className="text-fg-subtle enabled:hover:text-fg-default"
            data-testid="collapse-preview"
            title={t('preview.collapse')}
            tooltipPlacement="bottom"
            onClick={onCollapse}
          >
            <PanelRightClose aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
