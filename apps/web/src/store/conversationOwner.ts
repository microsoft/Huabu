// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getQuestionNodeStatus } from '@huabu/shared';
import { projectAgentNodeEditableData } from '@huabu/shared/canvas-engine';

import { acknowledgeAgentNodeResult, postCanvasExecute } from '@/api/canvas';
import useCanvasStore, { awaitQuestionCreation } from '@/store/canvasStore';

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
  bindingState?: 'editing' | 'bound';
  invocationToken?: string;
  content?: unknown;
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

export function conversationViewForNode(
  node: Node,
  canvasId: string,
  reference: ResolvedWorldReference | undefined,
): AgentConversationView | null {
  if (node.type === 'question' && typeof node.data.threadId === 'string') {
    return {
      presentationAnchor: { canvasId, nodeId: node.id },
      conversationOwner: {
        canvasId,
        nodeId: node.id,
        threadId: node.data.threadId,
      },
    };
  }
  return conversationViewFromWorldReference(canvasId, node.id, reference);
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
  const hasAuthoredContent = headless
    ? source?.hasAuthoredContent !== false
    : typeof source?.content === 'string' && source.content.trim().length > 0;
  return getQuestionNodeStatus(source) === 'idle' && !hasAuthoredContent;
}

/** Prefer the conversation owner's durable binding over an ephemeral cache. */
export function resolveConversationAgentBinding(
  source: ConversationOwnerSource | undefined,
  cachedBinding: AgentBinding,
): AgentBinding {
  return source?.agentBinding ?? cachedBinding;
}

/** Lifecycle and association are never ordinary browser edits. */
export function filterClientOwnedQuestionPatch(
  _source: ConversationOwnerSource | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const editable = projectAgentNodeEditableData(patch);
  return Object.keys(editable).length > 0 ? editable : null;
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
  await awaitQuestionCreation(owner.canvasId, owner.nodeId);
  const editable = filterClientOwnedQuestionPatch(undefined, patch);
  if (!editable || Object.keys(editable).length !== Object.keys(patch).length) {
    throw new Error('Agent Node lifecycle and association are server-owned');
  }
  const wirePatch = Object.fromEntries(
    Object.entries(editable).filter(([, value]) => value !== undefined),
  );
  const response = await postCanvasExecute(owner.canvasId, {
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: owner.nodeId, patch: wirePatch }],
      },
    ],
    originator: { source: 'ui' },
  });
  if (!response.results[0]?.applied) {
    throw new Error('Conversation owner node could not be updated');
  }

  const current = useCanvasStore.getState();
  if (
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

const draftSaves = new Map<string, Promise<void>>();

function draftKey(view: AgentConversationView): string {
  return `${view.conversationOwner.canvasId}\0${view.conversationOwner.nodeId}`;
}

export function saveConversationDraft(
  view: AgentConversationView,
  patch: {
    agentBinding: AgentBinding;
    agentMode: 'ask' | 'operate';
    agentIcon?: unknown;
  },
): Promise<void> {
  const save = patchConversationOwnerNode(view, patch).then(async () => {
    await refreshConversationPresentation(view);
    if (draftSaves.get(draftKey(view)) !== save) return;
    const state = useCanvasStore.getState();
    const source = resolveConversationOwnerSource(
      state.canvasId,
      state.nodes,
      state.worldReferences,
      view,
    );
    const actual = source?.agentBinding;
    if (!source && state.canvasId !== view.conversationOwner.canvasId) return;
    if (
      !actual ||
      actual.kind !== patch.agentBinding.kind ||
      (actual.kind === 'external' &&
        patch.agentBinding.kind === 'external' &&
        actual.profileId !== patch.agentBinding.profileId) ||
      source?.agentMode !== patch.agentMode
    ) {
      throw new ConversationIntegrityError(
        'Agent selection changed before the draft was acknowledged',
      );
    }
  });
  draftSaves.set(draftKey(view), save);
  // Keep a rejected save available to the send guard until an explicit retry.
  void save.catch(() => undefined);
  return save;
}

export async function awaitConversationDraft(
  view: AgentConversationView,
): Promise<void> {
  await awaitQuestionCreation(
    view.conversationOwner.canvasId,
    view.conversationOwner.nodeId,
  );
  await draftSaves.get(draftKey(view));
}

export async function acknowledgeConversationResult(
  view: AgentConversationView,
  source: ConversationOwnerSource | undefined,
): Promise<void> {
  if (
    !source ||
    source.viewed ||
    (source.status !== 'done' && source.status !== 'error')
  )
    return;
  await acknowledgeAgentNodeResult(
    view.conversationOwner.canvasId,
    view.conversationOwner.nodeId,
    { invocationToken: source.invocationToken ?? null },
  );
  await refreshConversationPresentation(view);
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
