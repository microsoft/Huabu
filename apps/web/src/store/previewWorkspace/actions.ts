// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { t } from 'i18next';

import { createId, isFileReference } from '@huabu/shared';

import { ApiError } from '@/api/_client';
import { getAgentConversationOwner } from '@/api/agent';
import { pageLifecycle } from '@/utils/pageLifecycle';

import {
  loadDefaultAgentBinding,
  toastConversationStartError,
} from '../acpProfilesStore';
import { selectCanWriteCanvas } from '../canvasStore';
import useCanvasStore from '../canvasStore';
import { rememberPreviewedAgent } from '../commentDestinationMemory';
import { createConversation } from '../conversationPreparation';
import { usePanelStore } from '../panelStore';
import { useWorkspaceStore } from '../workspaceStore';
import { findTabByTarget, groupOfTab, normalizePreviewTarget } from './model';
import { selectActiveTab, usePreviewWorkspaceStore } from './store';

import type { CanvasNodeId, FileReference } from '@huabu/shared';

export function addFileReferenceNode(
  canvasId: string,
  reference: FileReference,
  label: string,
): string {
  const canvas = useCanvasStore.getState();
  if (!isFileReference(reference)) throw new Error(t('files.invalidReference'));
  if (canvas.canvasId !== canvasId || canvas.isLoading)
    throw new Error(t('files.spaceChanged'));
  if (!selectCanWriteCanvas(canvas))
    throw new Error(t('files.creationReadOnly'));
  const id = createId('node');
  canvas.addNode({
    id,
    nodeType: 'fileReference',
    data: {
      label,
      origin: { type: 'user-created' },
      fileReference: reference,
    },
    size: { width: 400, height: 180 },
  });
  if (
    useCanvasStore.getState().canvasId !== canvasId ||
    !useCanvasStore.getState().nodes.some((node) => node.id === id)
  )
    throw new Error(t('files.creationFailed'));
  return id;
}

export function openFileReference(
  canvasId: string,
  reference: FileReference,
  label: string,
): string {
  const canvas = useCanvasStore.getState();
  if (!isFileReference(reference)) throw new Error(t('files.invalidReference'));
  if (canvas.canvasId !== canvasId || canvas.isLoading)
    throw new Error(t('files.spaceChanged'));
  const matches = canvas.nodes.filter(
    (node) =>
      node.type === 'fileReference' &&
      isFileReference(node.data.fileReference) &&
      node.data.fileReference.agentletId === reference.agentletId &&
      node.data.fileReference.path === reference.path,
  );
  const openMatch = Object.values(
    usePreviewWorkspaceStore.getState().workspace.tabs,
  )
    .sort((a, b) => b.lastActiveSeq - a.lastActiveSeq)
    .find(
      ({ target }) =>
        target.kind === 'node' &&
        target.canvasId === canvasId &&
        matches.some((node) => node.id === target.nodeId),
    );
  const nodeId =
    (openMatch?.target.kind === 'node' ? openMatch.target.nodeId : undefined) ??
    matches[0]?.id ??
    addFileReferenceNode(canvasId, reference, label);
  return openPreviewNode(nodeId, { transient: false, focusEditor: false });
}

function findConversationTab(
  canvasId: string,
  threadId: string,
  nodeId?: string,
) {
  return Object.values(usePreviewWorkspaceStore.getState().workspace.tabs).find(
    ({ target }) =>
      target.canvasId === canvasId &&
      ((target.kind === 'conversation' && target.threadId === threadId) ||
        (target.kind === 'node' && target.nodeId === nodeId)),
  );
}

export async function openConversationThread(
  canvasId: string,
  threadId: string,
): Promise<string> {
  const preview = usePreviewWorkspaceStore.getState();
  const canvas = useCanvasStore.getState();
  const node =
    canvas.canvasId === canvasId
      ? canvas.nodes.find(
          (item) => item.type === 'question' && item.data.threadId === threadId,
        )
      : undefined;
  const existing = findConversationTab(canvasId, threadId, node?.id);
  if (existing) {
    usePanelStore.getState().requestOpenRightPanel();
    preview.activateTab(existing.id);
    return existing.id;
  }
  if (node) return openSpaceConversation(canvasId, node.id, threadId);
  if (canvas.canvasId !== canvasId || canvas.isLoading) {
    try {
      const owner = await getAgentConversationOwner(canvasId, threadId);
      if (usePreviewWorkspaceStore.getState().canvasId !== preview.canvasId)
        throw new Error(
          'The active Space changed while opening the conversation',
        );
      return openSpaceConversation(canvasId, owner.nodeId, threadId);
    } catch (error) {
      if (
        !(
          error instanceof ApiError &&
          error.code === 'conversation_owner_missing'
        )
      )
        throw error;
    }
  }
  if (usePreviewWorkspaceStore.getState().canvasId !== preview.canvasId)
    throw new Error('The active Space changed while opening the conversation');
  usePanelStore.getState().requestOpenRightPanel();
  return usePreviewWorkspaceStore
    .getState()
    .openPreviewTarget({ kind: 'chat', canvasId, threadId });
}

export function openSpaceConversation(
  canvasId: string,
  nodeId: string,
  threadId: string,
  options?: { openToSide?: boolean },
): string {
  const preview = usePreviewWorkspaceStore.getState();
  usePanelStore.getState().requestOpenRightPanel();
  const existing = findConversationTab(canvasId, threadId, nodeId);
  const tabId =
    existing?.id ??
    preview.openPreviewTarget(
      {
        kind: 'conversation',
        canvasId,
        nodeId,
        threadId,
      },
      options,
    );
  if (existing) preview.activateTab(existing.id);
  preview.requestChatOpen(tabId, 'bottom');
  return tabId;
}

export function openPreviewNode(
  nodeId: string,
  options?: {
    transient?: boolean;
    focusEditor?: boolean;
    markReadIntent?: boolean;
    openToSide?: boolean;
    groupId?: string;
    userInitiated?: boolean;
  },
): string {
  const canvas = useCanvasStore.getState();
  usePanelStore.getState().requestOpenRightPanel();
  const tabId = usePreviewWorkspaceStore.getState().openPreviewTarget(
    {
      kind: 'node',
      canvasId: canvas.canvasId,
      nodeId,
    },
    {
      transient: options?.transient ?? true,
      markReadIntent: options?.markReadIntent,
      openToSide: options?.openToSide,
      groupId: options?.groupId,
    },
  );
  const openedNode = canvas.nodes.find((node) => node.id === nodeId);
  if (tabId && options?.userInitiated) {
    rememberPreviewedAgent({ kind: 'node', canvasId: canvas.canvasId, nodeId });
  }
  if (tabId && openedNode?.type === 'note' && options?.focusEditor !== false) {
    usePreviewWorkspaceStore.getState().requestNodeFocus(tabId);
  } else if (tabId && options?.focusEditor === false) {
    const preview = usePreviewWorkspaceStore.getState();
    const request = preview.nodeFocusRequest;
    if (request?.tabId === tabId) {
      preview.consumeNodeFocusRequest(tabId, request.nonce);
    }
  }
  return tabId;
}

/** Keep the PDF visible while reusing its owned notes view. */
export function openPdfNotes(pdfId: string): string {
  const canvas = useCanvasStore.getState();
  const pdf = canvas.nodes.find(
    (node) => node.id === pdfId && node.type === 'pdf',
  );
  if (!pdf) throw new Error('PDF not found');
  let noteId =
    typeof pdf.data.noteNodeId === 'string' ? pdf.data.noteNodeId : undefined;
  if (!noteId) {
    if (!selectCanWriteCanvas(canvas))
      throw new Error(t('node.pdfNotesReadOnly'));
    canvas.executeCommands(
      [{ type: 'INITIALIZE_PDF_NOTE', nodeId: pdfId as CanvasNodeId }],
      'ui',
    );
    const updatedPdf = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === pdfId);
    noteId =
      typeof updatedPdf?.data.noteNodeId === 'string'
        ? updatedPdf.data.noteNodeId
        : undefined;
  }
  if (
    !noteId ||
    !useCanvasStore
      .getState()
      .nodes.some((node) => node.id === noteId && node.type === 'note')
  )
    throw new Error('PDF note is unavailable');
  const sourceTab = openPreviewNode(pdfId, {
    transient: false,
    focusEditor: false,
  });
  const preview = usePreviewWorkspaceStore.getState();
  const groupId = groupOfTab(preview.workspace, sourceTab)?.id;
  return openPreviewNode(noteId, {
    transient: false,
    openToSide: true,
    groupId,
  });
}

/** Opens the most recently used Chat, creating one when none exists. */
export async function openChat(): Promise<string> {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';

  const recentChat = Object.values(preview.workspace.tabs)
    .filter(
      (tab) => tab.target.kind === 'chat' && tab.target.canvasId === canvasId,
    )
    .sort((a, b) => b.lastActiveSeq - a.lastActiveSeq)[0];
  if (recentChat?.target.kind !== 'chat') return openNewChat();
  const threadId = recentChat.target.threadId;

  usePanelStore.getState().requestOpenRightPanel();
  const tabId = preview.openPreviewTarget({ kind: 'chat', canvasId, threadId });
  usePanelStore.getState().requestFocusChatInput(threadId);
  return tabId;
}

/** Creates a Chat only after defaults load, without stealing a changed UI. */
export async function openNewChat(groupId?: string): Promise<string> {
  const initial = usePreviewWorkspaceStore.getState();
  const canvasId = initial.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';
  // Space ids are scoped to a Workspace, so the same id after a Workspace
  // switch names a different Space.
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  const inInitialSpace = () =>
    useWorkspaceStore.getState().workspaceId === workspaceId &&
    useCanvasStore.getState().canvasId === canvasId;
  try {
    return await pageLifecycle.run('updating', async () => {
      const binding = await loadDefaultAgentBinding();
      const preview = usePreviewWorkspaceStore.getState();
      if (
        !inInitialSpace() ||
        preview.canvasId !== initial.canvasId ||
        preview.workspace !== initial.workspace
      ) {
        return '';
      }
      const group = preview.workspace.groups.find(
        (entry) => entry.id === (groupId ?? preview.workspace.activeGroupId),
      );
      if (!group) return '';
      const threadId = createConversation({ canvasId, binding });
      usePanelStore.getState().requestOpenRightPanel();
      const tabId = preview.openPreviewTarget(
        { kind: 'chat', canvasId, threadId },
        { groupId: group.id },
      );
      usePanelStore.getState().requestFocusChatInput(threadId);
      return tabId;
    });
  } catch (error) {
    // A missing Agent offers setup. The toast outlives this call, so its retry
    // opens the requested Chat only while the same Space is still open.
    toastConversationStartError(error, () => {
      if (inInitialSpace()) void openNewChat(groupId);
    });
    return '';
  }
}

/** Follow a document link without consuming its source inspection tab. */
export function openPreviewUrl(
  href: string,
  sourceNodeId?: string,
  sourceThreadId?: string,
): string {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId;
  if (!canvasId) return '';
  const target = normalizePreviewTarget({ kind: 'url', canvasId, url: href });
  if (!target) return '';
  const source = sourceNodeId
    ? findTabByTarget(preview.workspace, {
        kind: 'node',
        canvasId,
        nodeId: sourceNodeId,
      })
    : sourceThreadId
      ? (findTabByTarget(preview.workspace, {
          kind: 'chat',
          canvasId,
          threadId: sourceThreadId,
        }) ??
        Object.values(preview.workspace.tabs).find(
          (tab) =>
            tab.target.kind === 'conversation' &&
            tab.target.threadId === sourceThreadId,
        ))
      : null;
  const groupId = source
    ? groupOfTab(preview.workspace, source.id)?.id
    : undefined;
  if (source) {
    preview.promoteTab(source.id);
  }
  usePanelStore.getState().requestOpenRightPanel();
  return preview.openPreviewTarget(target, { groupId });
}

/** Inspect a device file in the reusable Preview slot without creating a node. */
export function openPreviewFile(file: {
  agentletId: string;
  path: string;
  deviceName?: string;
}): string {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId;
  if (!canvasId) return '';
  const target = normalizePreviewTarget({ kind: 'file', canvasId, ...file });
  if (!target) return '';
  usePanelStore.getState().requestOpenRightPanel();
  return preview.openPreviewTarget(target, { transient: true });
}

/**
 * Close the node-free Preview of a device file. Once a reference node shows
 * the same file, the two tabs would only duplicate each other.
 */
export function closePreviewFile(file: {
  agentletId: string;
  path: string;
}): void {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId;
  if (!canvasId) return;
  const tab = findTabByTarget(preview.workspace, {
    kind: 'file',
    canvasId,
    ...file,
  });
  if (tab) preview.closeTab(tab.id);
}

export function closeActivePreviewNode(): void {
  const preview = usePreviewWorkspaceStore.getState();
  const activeTab = selectActiveTab(preview);
  if (!activeTab) return;
  const target = activeTab?.target;
  if (target?.kind !== 'node') return;

  preview.closeTab(activeTab.id);
}
