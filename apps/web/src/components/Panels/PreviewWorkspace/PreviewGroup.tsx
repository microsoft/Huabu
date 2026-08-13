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

import type { TabDropIndicator } from './tabDnd';
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
  nodeFocusRequest: { tabId: string; nonce: number } | null;
  onNodeFocusRequestHandled: (tabId: string, nonce: number) => void;
  chatOpenRequest: {
    tabId: string;
    position: 'last-user' | 'bottom';
    nonce: number;
  } | null;
  onChatOpenRequestHandled: (tabId: string, nonce: number) => void;
  onOpenToSide: (tabId: string) => void;
  onNewChat: () => void;
  tabDropIndicator: TabDropIndicator | null;
  /** Collapses the whole surface; only the last group offers it. */
  onCollapse?: () => void;
};

export function PreviewGroup({
  group,
  workspace,
  isFocused,
  onFocus,
  onActivate,
  onClose,
  onPromote,
  nodeFocusRequest,
  onNodeFocusRequestHandled,
  chatOpenRequest,
  onChatOpenRequestHandled,
  onOpenToSide,
  onNewChat,
  tabDropIndicator,
  onCollapse,
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
      className="flex h-full min-w-0 flex-1 flex-col"
    >
      <PreviewTabStrip
        groupId={group.id}
        tabs={tabs}
        activeTabId={group.activeTabId}
        onActivate={onActivate}
        onClose={onClose}
        onPromote={onPromote}
        onOpenToSide={onOpenToSide}
        onNewChat={onNewChat}
        canOpenToSide={workspace.groups.length < 2 && tabs.length > 1}
        tabDropIndicator={tabDropIndicator}
        onCollapse={onCollapse}
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
          <PreviewRenderer
            tabId={activeTab.id}
            target={activeTab.target}
            onClose={() => onClose(activeTab.id)}
            onCommit={() => onPromote(activeTab.id)}
            nodeFocusRequestNonce={
              nodeFocusRequest?.tabId === activeTab.id
                ? nodeFocusRequest.nonce
                : undefined
            }
            onNodeFocusRequestHandled={(nonce) =>
              onNodeFocusRequestHandled(activeTab.id, nonce)
            }
            chatOpenRequest={
              chatOpenRequest?.tabId === activeTab.id
                ? chatOpenRequest
                : undefined
            }
            onChatOpenRequestHandled={(nonce) =>
              onChatOpenRequestHandled(activeTab.id, nonce)
            }
            hasFocusPriority={isFocused}
          />
        ) : (
          <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
            {t('preview.emptyGroup')}
          </div>
        )}
      </div>
    </section>
  );
}
