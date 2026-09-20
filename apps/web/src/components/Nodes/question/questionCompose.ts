// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared orchestration for entering a question node's chat conversation.
 *
 * Question nodes are born bound to a chat thread. Every entry point that
 * "enters" that conversation (toolbar placement, connected-node picker,
 * double-click compose) needs the same steps: mint the thread, open the
 * chat panel in compose mode, and focus the input. Keeping it in one place
 * ensures those steps stay in sync across callers.
 */
import { createId } from '@huabu/shared';

import { associateAgentNode } from '@/api/canvas';
import { toast } from '@/components/Common/Toast';
import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  useAcpProfilesStore,
} from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore.ts';
import { selectThreadBinding, useChatStore } from '@/store/chatStore.ts';
import {
  resolveConversationOwnerSource,
  saveConversationDraft,
} from '@/store/conversationOwner';
import { usePanelStore } from '@/store/panelStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions.ts';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store.ts';
import { snapshotAgentIcon } from '@/utils/agentIcon';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent.ts';
import type {
  AgentBinding,
  AgentConversationView,
  AgentMode,
  CanvasNodeId,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/** Legacy Questions acquire an identity on the server before compose opens. */
export async function ensureQuestionThread(
  canvasId: string,
  nodeId: string,
): Promise<string> {
  const initial = useCanvasStore.getState();
  const existing = initial.nodes.find((node) => node.id === nodeId);
  if (initial.canvasId !== canvasId || existing?.type !== 'question')
    throw new Error('Agent Node no longer exists');
  if (typeof existing.data.threadId === 'string' && existing.data.threadId)
    return existing.data.threadId;
  const response = await associateAgentNode(canvasId, nodeId, {
    kind: 'initialize',
  });
  const current = useCanvasStore.getState();
  const live = current.nodes.find((node) => node.id === nodeId);
  if (current.canvasId !== canvasId || live?.type !== 'question')
    throw new Error('Agent Node no longer exists');
  const confirmed = response.node as Node;
  if (!live.data.threadId) {
    current._setStateNoAutosave({
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                threadId: confirmed.data.threadId,
                bindingState: confirmed.data.bindingState,
                agentBinding:
                  confirmed.data.agentBinding ?? node.data.agentBinding,
              },
            }
          : node,
      ),
      ...(current.version === response.fromVersion
        ? { version: response.toVersion }
        : {}),
    });
  }
  const threadId = useCanvasStore
    .getState()
    .nodes.find((node) => node.id === nodeId)?.data.threadId;
  if (typeof threadId !== 'string' || !threadId)
    throw new Error('Agent Node association was not acknowledged');
  return threadId;
}

function initializeQuestionBinding(
  view: AgentConversationView,
  binding: AgentBinding | undefined,
  saveDraft: boolean,
): void {
  const chat = useChatStore.getState();
  const canvas = useCanvasStore.getState();
  const source = resolveConversationOwnerSource(
    canvas.canvasId,
    canvas.nodes,
    view,
  );
  const effectiveBinding =
    source?.agentBinding ??
    binding ??
    selectThreadBinding(chat, view.conversationOwner.threadId);
  if (effectiveBinding) {
    chat.setAgentBinding(view.conversationOwner.threadId, effectiveBinding);
  }
  const mode =
    source?.agentMode ??
    (effectiveBinding.kind === 'internal' ? 'operate' : 'ask');
  chat.setThreadLastAction(view.conversationOwner.threadId, mode);
  if (saveDraft && !source?.agentBinding && source?.bindingState !== 'bound') {
    const profiles = useAcpProfilesStore.getState().profiles;
    const profile =
      effectiveBinding.kind === 'external'
        ? profiles.find((entry) => entry.id === effectiveBinding.profileId)
        : undefined;
    const icon = snapshotAgentIcon(effectiveBinding, profiles);
    void saveConversationDraft(view, {
      agentBinding:
        profile && effectiveBinding.kind === 'external'
          ? { ...effectiveBinding, alias: profile.alias }
          : effectiveBinding,
      agentMode: mode,
      ...(icon ? { agentIcon: icon } : {}),
    })
      .then(() =>
        chat.makeThreadMetadataEphemeral(view.conversationOwner.threadId, {
          preserveSettings: true,
        }),
      )
      .catch((error) =>
        toast(
          error instanceof Error
            ? error.message
            : 'Failed to save Agent selection',
          { tone: 'danger' },
        ),
      );
  }
}

/** Open an authored Question conversation in the active presentation mode. */
export function enterQuestionConversation(
  view: AgentConversationView,
  binding: AgentBinding | undefined,
  _canvasId: string | null,
  openPosition: 'last-user' | 'bottom',
  options?: { transient?: boolean },
): void {
  useChatStore
    .getState()
    .makeThreadMetadataEphemeral(view.conversationOwner.threadId);
  initializeQuestionBinding(view, binding, false);
  const tabId = openPreviewNode(view.presentationAnchor.nodeId, options);
  if (tabId) {
    usePreviewWorkspaceStore.getState().requestChatOpen(tabId, openPosition);
  }
}

/**
 * Open the chat panel in compose mode for a question node's thread and
 * focus the input.
 */
export function enterQuestionCompose(
  view: AgentConversationView,
  _canvasId: string | null,
  binding?: AgentBinding,
  options?: { transient?: boolean },
): void {
  initializeQuestionBinding(view, binding, true);
  openPreviewNode(view.presentationAnchor.nodeId, options);
  usePanelStore
    .getState()
    .requestFocusChatInput(view.conversationOwner.threadId);
}

/**
 * Create a question node bound to a fresh thread at `placementPoint` and
 * enter compose after loading the default Profile. IDs are returned only
 * after creation so callers can wire follow-up work (e.g. a connecting edge).
 * Pass `id` to reuse a pre-minted node id.
 */
export async function createQuestionNodeAndCompose(opts: {
  addNode: (input: AddNodeInput) => void;
  placementPoint: { x: number; y: number };
  canvasId: string | null;
  id?: CanvasNodeId;
  /** Additional caller-owned scope, such as a connected source node. */
  isCurrent?: () => boolean;
}): Promise<{ nodeId: CanvasNodeId; threadId: string } | null> {
  const canvasId = opts.canvasId ?? useCanvasStore.getState().canvasId;
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  try {
    const binding = await loadDefaultAgentBinding();
    if (
      useCanvasStore.getState().canvasId !== canvasId ||
      usePreviewWorkspaceStore.getState().workspace !== workspace ||
      opts.isCurrent?.() === false
    ) {
      return null;
    }
    const created = createQuestionNode({ ...opts, canvasId, binding });
    enterQuestionCompose(created.conversationView, canvasId, binding);
    return { nodeId: created.nodeId, threadId: created.threadId };
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), {
      tone: 'danger',
    });
    return null;
  }
}

export function createQuestionNode(opts: {
  addNode: (input: AddNodeInput) => void;
  placementPoint: { x: number; y: number };
  canvasId: string | null;
  id?: CanvasNodeId;
  binding?: AgentBinding;
  mode?: AgentMode;
  label?: string;
  pendingInkIntentLabel?: boolean;
}): {
  nodeId: CanvasNodeId;
  threadId: string;
  conversationView: AgentConversationView;
} {
  const binding = opts.binding ?? getDefaultAgentBinding();
  const mode = opts.mode ?? (binding.kind === 'external' ? 'ask' : 'operate');
  const profiles = useAcpProfilesStore.getState().profiles;
  const icon = snapshotAgentIcon(binding, profiles);
  const nodeId = opts.id ?? (createId('node') as CanvasNodeId);
  const threadId = createId('thread');
  const canvasId = opts.canvasId ?? useCanvasStore.getState().canvasId;
  opts.addNode({
    id: nodeId,
    nodeType: 'question',
    placementPoint: opts.placementPoint,
    data: {
      content: '',
      threadId,
      agentBinding: binding,
      agentMode: mode,
      ...(icon ? { agentIcon: icon } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.pendingInkIntentLabel ? { pendingInkIntentLabel: true } : {}),
      origin: { type: 'user-created' },
    },
  });
  const conversationView: AgentConversationView = {
    presentationAnchor: {
      canvasId,
      nodeId,
    },
    conversationOwner: {
      canvasId,
      nodeId,
      threadId,
    },
  };
  useChatStore.getState().setAgentBinding(threadId, binding);
  useChatStore.getState().setThreadLastAction(threadId, mode);
  return { nodeId, threadId, conversationView };
}
