// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getQuestionNodeStatus } from '@huabu/shared';

import { postCanvasExecute } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';

import type { AgentBinding, AgentConversationView } from '@huabu/shared';
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
  content?: unknown;
};

const ownerPatchChains = new Map<string, Promise<void>>();

export class ConversationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationIntegrityError';
  }
}

export function conversationViewForNode(
  node: Node,
  canvasId: string,
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
  return null;
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
    includeCanvasSelection:
      !view || view.conversationOwner.canvasId === activeCanvasId,
  };
}

export function shouldComposeConversationOwner(
  source: ConversationOwnerSource | undefined,
): boolean {
  const hasAuthoredContent =
    typeof source?.content === 'string' && source.content.trim().length > 0;
  return getQuestionNodeStatus(source) === 'idle' && !hasAuthoredContent;
}

/** Prefer the conversation owner's durable binding over an ephemeral cache. */
export function resolveConversationAgentBinding(
  source: ConversationOwnerSource | undefined,
  cachedBinding: AgentBinding,
): AgentBinding {
  return source?.agentBinding ?? cachedBinding;
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
  const active = useCanvasStore.getState();
  const owner = view.conversationOwner;
  const node = active.nodes.find((candidate) => candidate.id === owner.nodeId);
  if (
    active.canvasId !== owner.canvasId ||
    view.presentationAnchor.canvasId !== owner.canvasId ||
    view.presentationAnchor.nodeId !== owner.nodeId ||
    node?.type !== 'question' ||
    node.data.threadId !== owner.threadId
  ) {
    throw new ConversationIntegrityError(
      'Conversation owner no longer matches the active Agent node',
    );
  }
}

export function resolveConversationOwnerSource(
  activeCanvasId: string,
  nodes: readonly Node[],
  view: AgentConversationView | null,
): ConversationOwnerSource | undefined {
  if (!view || view.conversationOwner.canvasId !== activeCanvasId)
    return undefined;
  return nodes.find(
    (node) =>
      node.id === view.conversationOwner.nodeId && node.type === 'question',
  )?.data as ConversationOwnerSource | undefined;
}

async function applyConversationOwnerPatch(
  view: AgentConversationView,
  patch: Record<string, unknown>,
): Promise<void> {
  const owner = view.conversationOwner;
  const active = useCanvasStore.getState();
  const ownerIsActive =
    active.canvasId === owner.canvasId &&
    active.nodes.some((node) => node.id === owner.nodeId);
  if (ownerIsActive) {
    // Reflect lifecycle changes immediately, but still persist them through
    // the canonical executor below. A local-only status disappears on reload;
    // load-time code cannot safely infer success from conversation existence.
    active.patchNodeSilent(owner.nodeId, patch);
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
  } else if (ownerIsActive && current.canvasId === owner.canvasId) {
    // A Canvas-sync broadcast may have advanced the version before this
    // response returned. The optimistic patch is already visible; the server
    // command above is the durable source of truth.
    current.patchNodeSilent(owner.nodeId, patch);
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
