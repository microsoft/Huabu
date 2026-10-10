// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * One preview group: a tab strip over a bounded set of rendered panels.
 *
 * The active tab and one recent eligible tab retain their component state.
 * Older and resource-heavy tabs are unmounted (§4).
 */

import { Activity, useCallback, useRef, useState } from 'react';
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

import type { ChatConnectionChangeHandler } from './PreviewRenderer';
import type { TabDropIndicator } from './tabDnd';
import type { AcpConnectionInfo } from '../ChatPanel/AcpConnectionBadge';
import type {
  CanvasPreviewWorkspace,
  ClosePreviewTabsScope,
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
  onCloseTabs: (tabId: string, scope: ClosePreviewTabsScope) => void;
  onPromote: (tabId: string) => void;
  nodeFocusRequest: { tabId: string; nonce: number } | null;
  onNodeFocusRequestHandled: (tabId: string, nonce: number) => void;
  chatOpenRequest: {
    tabId: string;
    position: 'last-user' | 'bottom';
    nonce: number;
  } | null;
  onChatOpenRequestHandled: (tabId: string, nonce: number) => void;
  onSplit: () => void;
  onCloseEmptyGroup: () => void;
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
  onCloseTabs,
  onPromote,
  nodeFocusRequest,
  onNodeFocusRequestHandled,
  chatOpenRequest,
  onChatOpenRequestHandled,
  onSplit,
  onCloseEmptyGroup,
  onNewChat,
  tabDropIndicator,
  isFullscreen,
  onToggleFullscreen,
  onCollapse,
}: PreviewGroupProps) {
  const { t } = useTranslation();
  const nextRenameNonce = useRef(0);
  const [titleEditorHost, setTitleEditorHost] =
    useState<HTMLSpanElement | null>(null);
  const [chatConnection, setChatConnection] = useState<{
    tabId: string;
    targetKey: string;
    connection: AcpConnectionInfo;
  } | null>(null);
  const handleChatConnectionChange = useCallback<ChatConnectionChangeHandler>(
    (tabId, targetKey, connection) => {
      setChatConnection((current) =>
        connection
          ? { tabId, targetKey, connection }
          : current?.tabId === tabId && current.targetKey === targetKey
            ? null
            : current,
      );
    },
    [],
  );
  const [renameRequest, setRenameRequest] = useState<{
    tabId: string;
    nonce: number;
    targetKey: string;
  } | null>(null);
  const handleRenameRequest = (tabId: string) => {
    // Renaming supersedes a deferred content-focus request for the same tab.
    if (nodeFocusRequest?.tabId === tabId) {
      onNodeFocusRequestHandled(tabId, nodeFocusRequest.nonce);
    }
    onActivate(tabId);
    setRenameRequest({
      tabId,
      nonce: ++nextRenameNonce.current,
      targetKey: previewTargetKey(workspace.tabs[tabId].target),
    });
  };
  const handleRenameRequestHandled = useCallback((nonce: number) => {
    setRenameRequest((current) => (current?.nonce === nonce ? null : current));
  }, []);
  const [activation, setActivation] = useState({
    tabId: group.activeTabId,
    id: 0,
  });
  if (activation.tabId !== group.activeTabId) {
    setActivation({ tabId: group.activeTabId, id: activation.id + 1 });
  }
  const tabs = group.tabIds
    .map((id) => workspace.tabs[id])
    .filter((tab) => tab !== undefined);
  const activeTab = group.activeTabId
    ? workspace.tabs[group.activeTabId]
    : undefined;
  if (
    renameRequest &&
    (!isFocused ||
      activeTab?.id !== renameRequest.tabId ||
      previewTargetKey(activeTab.target) !== renameRequest.targetKey)
  ) {
    setRenameRequest(null);
  }
  const retainableTabIds = useCanvasStore(
    useShallow((state) =>
      group.tabIds.flatMap((tabId) => {
        const tab = workspace.tabs[tabId];
        if (!tab) return [];
        if (tab.target.kind === 'chat') return [tabId];
        if (tab.target.kind === 'url') return [];
        const nodeId = tab.target.nodeId;
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        return node && canRetainPreviewNode(node) ? [tabId] : [];
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
        onCloseTabs={onCloseTabs}
        onPromote={onPromote}
        onRename={handleRenameRequest}
        onTitleEditorHostChange={setTitleEditorHost}
        activeChatConnection={
          activeTab &&
          chatConnection?.tabId === activeTab.id &&
          chatConnection.targetKey === previewTargetKey(activeTab.target)
            ? chatConnection.connection
            : undefined
        }
        onSplit={workspace.groups.length === 1 ? onSplit : undefined}
        onCloseEmptyGroup={
          workspace.groups.length > 1 && tabs.length === 0
            ? onCloseEmptyGroup
            : undefined
        }
        onNewChat={onNewChat}
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
                    isActive={isActive}
                    activationId={isActive ? activation.id : undefined}
                    target={tab.target}
                    adjacentNodeTarget={
                      isActive ? adjacentNodeTarget : undefined
                    }
                    onClose={() => onClose(tab.id)}
                    onCommit={() => onPromote(tab.id)}
                    renameRequestNonce={
                      isActive && renameRequest?.tabId === tab.id
                        ? renameRequest.nonce
                        : undefined
                    }
                    onRenameRequestHandled={handleRenameRequestHandled}
                    onChatConnectionChange={handleChatConnectionChange}
                    titleEditorHost={
                      isActive &&
                      titleEditorHost?.dataset.previewTitleEditorTabId ===
                        tab.id
                        ? titleEditorHost
                        : null
                    }
                    onRenameKeyboardEnd={() =>
                      document
                        .getElementById(tabElementId(group.id, tab.id))
                        ?.focus({ preventScroll: true })
                    }
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
          <div className="text-fg-subtle flex h-full items-center justify-center p-6 text-center text-sm">
            {t('preview.emptyGroup')}
          </div>
        )}
      </div>
    </section>
  );
}
