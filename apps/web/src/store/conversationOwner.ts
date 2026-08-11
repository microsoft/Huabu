// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getQuestionNodeStatus } from '@huabu/shared';

import { postCanvasExecute } from '@/api/canvas';
import { canvasSyncTabId } from '@/store/canvasCommitSync';
import useCanvasStore from '@/store/canvasStore';

import type {
  AgentBinding,
  AgentConversationView,
  ResolvedWorldReference,
} from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

export type ConversationOwnerSource = {
  type?: string;
  label?: string;
  labelSource?: 'auto' | 'user' | 'agent';
  status?: 'idle' | 'running' | 'done' | 'error';
  viewed?: boolean;
  agentMode?: 'ask' | 'operate';
  agentBinding?: AgentBinding;
  agentBindingPolicy?: 'selectable' | 'fixed';
  hasAuthoredContent?: boolean;
};

const ownerPatchChains = new Map<string, Promise<void>>();

export class ConversationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationIntegrityError';
  }
}

export function conversationViewFromWorldReference(
  presentationCanvasId: string,
  referenceNodeId: string,
  reference: ResolvedWorldReference | undefined,
): AgentConversationView | null {
  if (
    reference?.kind !== 'nodeRef' ||
    reference.status !== 'ok' ||
    reference.source?.type !== 'question'
  ) {
    return null;
  }
  if (!reference.source.threadId) {
    throw new ConversationIntegrityError(
      'Source Agent Node has no conversation thread',
    );
  }
  return {
    presentationAnchor: {
      canvasId: presentationCanvasId,
      nodeId: referenceNodeId,
    },
    conversationOwner: {
      canvasId: reference.target.canvasId,
      nodeId: reference.target.nodeId,
      threadId: reference.source.threadId,
    },
  };
}

export function isHeadlessConversation(
  view: AgentConversationView | null,
): boolean {
  return (
    !!view &&
    (view.presentationAnchor.canvasId !== view.conversationOwner.canvasId ||
      view.presentationAnchor.nodeId !== view.conversationOwner.nodeId)
  );
}

export function conversationRequestScope(
  view: AgentConversationView | null,
  activeCanvasId: string,
): {
  canvasId: string;
  anchorNodeId?: string;
  includeCanvasSelection: boolean;
} {
  return {
    canvasId: view?.conversationOwner.canvasId || activeCanvasId,
    ...(view ? { anchorNodeId: view.conversationOwner.nodeId } : {}),
    includeCanvasSelection: !isHeadlessConversation(view),
  };
}

export function shouldComposeConversationOwner(
  source: ConversationOwnerSource | undefined,
  headless: boolean,
): boolean {
  return (
    getQuestionNodeStatus(source) === 'idle' &&
    (!headless || source?.hasAuthoredContent === false)
  );
}

/** Keep client writes to fixed Agent Nodes limited to presentation state. */
export function filterClientOwnedQuestionPatch(
  source: ConversationOwnerSource | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  if (source?.agentBindingPolicy !== 'fixed') return patch;
  return typeof patch.viewed === 'boolean' ? { viewed: patch.viewed } : null;
}

export async function validateConversationView(
  view: AgentConversationView,
): Promise<void> {
  if (!isHeadlessConversation(view)) return;

  const active = useCanvasStore.getState();
  if (active.canvasId !== view.presentationAnchor.canvasId) {
    throw new ConversationIntegrityError(
      'Conversation presentation Canvas is no longer active',
    );
  }

  await active.refreshWorldReferences();
  const current = useCanvasStore.getState();
  if (current.canvasId !== view.presentationAnchor.canvasId) {
    throw new ConversationIntegrityError(
      'Conversation presentation Canvas changed during validation',
    );
  }

  const latest = conversationViewFromWorldReference(
    view.presentationAnchor.canvasId,
    view.presentationAnchor.nodeId,
    current.worldReferences[view.presentationAnchor.nodeId],
  );
  if (
    !latest ||
    latest.conversationOwner.canvasId !== view.conversationOwner.canvasId ||
    latest.conversationOwner.nodeId !== view.conversationOwner.nodeId ||
    latest.conversationOwner.threadId !== view.conversationOwner.threadId
  ) {
    throw new ConversationIntegrityError(
      'Conversation owner no longer matches the World reference',
    );
  }
}

export function resolveConversationOwnerSource(
  activeCanvasId: string,
  nodes: readonly Node[],
  references: Record<string, ResolvedWorldReference>,
  view: AgentConversationView | null,
): ConversationOwnerSource | undefined {
  if (!view) return undefined;
  if (view.conversationOwner.canvasId === activeCanvasId) {
    return nodes.find((node) => node.id === view.conversationOwner.nodeId)
      ?.data as ConversationOwnerSource | undefined;
  }
  const reference = references[view.presentationAnchor.nodeId];
  if (
    reference?.kind !== 'nodeRef' ||
    reference.status !== 'ok' ||
    reference.target.canvasId !== view.conversationOwner.canvasId ||
    reference.target.nodeId !== view.conversationOwner.nodeId
  ) {
    return undefined;
  }
  return reference.source;
}

async function applyConversationOwnerPatch(
  view: AgentConversationView,
  patch: Record<string, unknown>,
): Promise<void> {
  const owner = view.conversationOwner;
  const active = useCanvasStore.getState();
  if (
    active.canvasId === owner.canvasId &&
    active.nodes.some((node) => node.id === owner.nodeId)
  ) {
    active.patchNodeSilent(owner.nodeId, patch);
    return;
  }

  const wirePatch = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      value === undefined ? '' : value,
    ]),
  );
  const response = await postCanvasExecute(owner.canvasId, {
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: owner.nodeId, patch: wirePatch }],
      },
    ],
    originator: { source: 'ui', tabId: canvasSyncTabId },
  });
  if (!response.results[0]?.applied) {
    throw new Error('Conversation owner node could not be updated');
  }

  const current = useCanvasStore.getState();
  if (current.canvasId === response.canvasId && response.commit) {
    const consumed = current.consumeCommit({
      kind: 'event',
      commit: response.commit,
      pendingEffects: response.pendingEffects as Parameters<
        typeof current.applyDeltasFromAgent
      >[2],
    });
    if (consumed.shouldReload) {
      await current.loadCanvas(response.canvasId, { resetHistory: true });
    }
  } else if (
    current.canvasId === response.canvasId &&
    current.version === response.fromVersion
  ) {
    current.applyDeltasFromAgent(
      response.deltas as Delta[],
      response.toVersion,
      response.pendingEffects as Parameters<
        typeof current.applyDeltasFromAgent
      >[2],
    );
  }
}

export function patchConversationOwnerNode(
  view: AgentConversationView,
  patch: Record<string, unknown>,
): Promise<void> {
  const owner = view.conversationOwner;
  const key = `${owner.canvasId}\0${owner.nodeId}`;
  const previous = ownerPatchChains.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => applyConversationOwnerPatch(view, patch));
  ownerPatchChains.set(key, current);
  return current.finally(() => {
    if (ownerPatchChains.get(key) === current) ownerPatchChains.delete(key);
  });
}

export async function refreshConversationPresentation(
  view: AgentConversationView,
): Promise<void> {
  const active = useCanvasStore.getState();
  if (
    active.canvasId !== view.presentationAnchor.canvasId ||
    !isHeadlessConversation(view)
  ) {
    return;
  }
  await active.refreshWorldReferences();
}
