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
import { Columns2, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PreviewTab } from './PreviewTab';
import { groupDropId } from './tabDnd';
import { Button } from '../../Common/Button';

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
  onCollapse,
}: PreviewTabStripProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({
    id: groupDropId(groupId),
    data: { type: 'preview-group', groupId },
  });

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
    <div className="border-edge-default bg-surface flex shrink-0 items-stretch border-b">
      <div
        ref={setNodeRef}
        role="tablist"
        aria-label={t('preview.tabStrip')}
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 overflow-x-auto"
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
            />
          ))}
        </SortableContext>
      </div>
      {(canOpenToSide || onCollapse) && (
        <div className="flex shrink-0 items-center px-1">
          {canOpenToSide && activeTabId && (
            <Button
              variant="ghost"
              iconOnly
              size="sm"
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
              size="sm"
              title={t('preview.collapse')}
              tooltipPlacement="bottom"
              onClick={onCollapse}
            >
              <PanelRightClose />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
