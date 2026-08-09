// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * One preview group: a tab strip over a single rendered panel.
 *
 * Only the active tab is mounted. Inactive tabs keep their model and store
 * state but not their component tree, so a group with many tabs costs one
 * renderer (§9).
 */

import { useTranslation } from 'react-i18next';

import { PreviewRenderer } from './PreviewRenderer';
import {
  panelElementId,
  PreviewTabStrip,
  tabElementId,
} from './PreviewTabStrip';
import { cn } from '../../Common/cn';

import type {
  CanvasPreviewWorkspace,
  PreviewGroup as PreviewGroupModel,
} from '@/store/previewWorkspace/model';

type PreviewGroupProps = {
  group: PreviewGroupModel;
  workspace: CanvasPreviewWorkspace;
  isFocused: boolean;
  onFocus: () => void;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPromote: (tabId: string) => void;
  onOpenToSide: (tabId: string) => void;
};

export function PreviewGroup({
  group,
  workspace,
  isFocused,
  onFocus,
  onActivate,
  onClose,
  onPromote,
  onOpenToSide,
}: PreviewGroupProps) {
  const { t } = useTranslation();
  const tabs = group.tabIds
    .map((id) => workspace.tabs[id])
    .filter((tab) => tab !== undefined);
  const activeTab = group.activeTabId
    ? workspace.tabs[group.activeTabId]
    : undefined;

  return (
    <section
      aria-label={t('preview.group')}
      // Focus follows interaction so keyboard handlers can ask "am I the
      // focused group" rather than assuming a single instance.
      onFocusCapture={onFocus}
      onPointerDownCapture={onFocus}
      className={cn(
        'flex h-full min-w-0 flex-1 flex-col',
        isFocused && workspace.groups.length > 1 && 'ring-info/40 ring-1',
      )}
    >
      <PreviewTabStrip
        groupId={group.id}
        tabs={tabs}
        activeTabId={group.activeTabId}
        onActivate={onActivate}
        onClose={onClose}
        onPromote={onPromote}
        onOpenToSide={onOpenToSide}
        canOpenToSide={workspace.groups.length < 2 && tabs.length > 1}
      />
      <div
        role="tabpanel"
        id={panelElementId(group.id)}
        aria-labelledby={
          activeTab ? tabElementId(group.id, activeTab.id) : undefined
        }
        className="min-h-0 flex-1 overflow-auto"
      >
        {activeTab ? (
          <PreviewRenderer target={activeTab.target} />
        ) : (
          <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
            {t('preview.emptyGroup')}
          </div>
        )}
      </div>
    </section>
  );
}
