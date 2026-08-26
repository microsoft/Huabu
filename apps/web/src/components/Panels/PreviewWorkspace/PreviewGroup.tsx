// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * One preview group: a tab strip over a bounded set of rendered panels.
 *
 * The active tab and one recent eligible tab retain their component state.
 * Older and resource-heavy tabs are unmounted (§4).
 */

import { Activity } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import useCanvasStore from '@/store/canvasStore';
import { previewTargetKey } from '@/store/previewWorkspace/scrollMemory';

import { PreviewRenderer } from './PreviewRenderer';
import {
  panelElementId,
  PreviewTabStrip,
  tabElementId,
} from './PreviewTabStrip';
import {
  canRetainPreviewNode,
  selectRetainedPreviewTabs,
} from './retainedPreviewTabs';

import type { TabDropIndicator } from './tabDnd';
import type {
  CanvasPreviewWorkspace,
  PreviewGroup as PreviewGroupModel,
  PreviewTarget,
} from '@/store/previewWorkspace/model';

type PreviewGroupProps = {
  group: PreviewGroupModel;
  workspace: CanvasPreviewWorkspace;
  adjacentNodeTarget?: Extract<PreviewTarget, { kind: 'node' }>;
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
  isFullscreen: boolean;
  onToggleFullscreen?: () => void;
  /** Collapses the whole surface; only the last group offers it. */
  onCollapse?: () => void;
};

export function PreviewGroup({
  group,
  workspace,
  adjacentNodeTarget,
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
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
}: PreviewGroupProps) {
  const { t } = useTranslation();
  const tabs = group.tabIds
    .map((id) => workspace.tabs[id])
    .filter((tab) => tab !== undefined);
  const activeTab = group.activeTabId
    ? workspace.tabs[group.activeTabId]
    : undefined;
  const retainableTabIds = useCanvasStore(
    useShallow((state) =>
      group.tabIds.flatMap((tabId) => {
        const tab = workspace.tabs[tabId];
        if (!tab) return [];
        if (tab.target.kind === 'chat') return [tabId];
        const nodeId = tab.target.nodeId;
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        return node &&
          canRetainPreviewNode(node, state.worldReferences[node.id])
          ? [tabId]
          : [];
      }),
    ),
  );
  const retainedTabs = selectRetainedPreviewTabs(
    group,
    workspace,
    new Set(retainableTabIds),
  );

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
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
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
          retainedTabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            return (
              <Activity
                key={`${tab.id}:${previewTargetKey(tab.target)}`}
                mode={isActive ? 'visible' : 'hidden'}
              >
                <div className="contents" data-preview-active={isActive}>
                  <PreviewRenderer
                    tabId={tab.id}
                    target={tab.target}
                    adjacentNodeTarget={
                      isActive ? adjacentNodeTarget : undefined
                    }
                    onClose={() => onClose(tab.id)}
                    onCommit={() => onPromote(tab.id)}
                    nodeFocusRequestNonce={
                      isActive && nodeFocusRequest?.tabId === tab.id
                        ? nodeFocusRequest.nonce
                        : undefined
                    }
                    onNodeFocusRequestHandled={(nonce) =>
                      onNodeFocusRequestHandled(tab.id, nonce)
                    }
                    chatOpenRequest={
                      isActive && chatOpenRequest?.tabId === tab.id
                        ? chatOpenRequest
                        : undefined
                    }
                    onChatOpenRequestHandled={(nonce) =>
                      onChatOpenRequestHandled(tab.id, nonce)
                    }
                    hasFocusPriority={isActive && isFocused}
                  />
                </div>
              </Activity>
            );
          })
        ) : (
          <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
            {t('preview.emptyGroup')}
          </div>
        )}
      </div>
    </section>
  );
}
