// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasEditableNodeDataSchema } from '@huabu/shared';
import {
  AGENT_NODE_PREPARATION_KEYS,
  projectAgentNodeEditableData,
} from '@huabu/shared/canvas-engine';

import { agenetes } from '../agent/agenetes/drivers.js';
import { getAgentDefaults } from '../agent/agent-defaults.js';
import { parseAgentLaunchOverrides } from '../agent/agent-launch-overrides.js';
import { agentNodeBinding } from '../agent/agent-node-binding.js';
import { agentThreadResolver } from '../agent/agent-thread-resolver.js';
import { effectiveConversationTitle } from '../agent/conversation-title.service.js';
import {
  requireSelectableAgentProfile,
  SelectableAgentProfileError,
  type SelectableAgentProfile,
} from '../agent/selectable-agent-profile.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { CanvasNodeId } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

interface EditableAgentNode {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export class AgentNodeEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNodeEditError';
  }
}

export function withDefaultAgentBinding(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (data.agentBinding) return data;
  const profileId = getAgentDefaults().profileId;
  if (!profileId) {
    throw new AgentNodeEditError(
      'Connect an external Agent and select a default Profile in Settings.',
    );
  }
  let profile: SelectableAgentProfile;
  try {
    profile = requireSelectableAgentProfile(profileId);
  } catch (error) {
    if (error instanceof SelectableAgentProfileError) {
      throw new AgentNodeEditError(error.message);
    }
    throw error;
  }
  return {
    ...data,
    agentBinding: {
      kind: 'external',
      profileId: profile.id,
      alias: profile.alias,
    },
  };
}

export function validateAgentNodeEditableData(
  data: Record<string, unknown>,
): void {
  const parsed = canvasEditableNodeDataSchema.safeParse(
    projectAgentNodeEditableData(data),
  );
  if (!parsed.success) {
    throw new AgentNodeEditError(
      parsed.error.issues[0]?.message ?? 'Invalid Agent Node edit',
    );
  }
  if (
    data.agentLaunchOverrides !== null &&
    data.agentLaunchOverrides !== undefined
  ) {
    try {
      parseAgentLaunchOverrides(data.agentLaunchOverrides);
    } catch (error) {
      throw new AgentNodeEditError(
        error instanceof Error ? error.message : 'Invalid launch overrides',
      );
    }
  }
}

/** Creation/attachment confirms the new owner's thread, not copied lifecycle data. */
export async function initializeAgentNodeCreationAlreadyLocked(
  canvasId: string,
  node: CanvasNode,
  requireBinding = false,
  applyDefault = false,
): Promise<CanvasNode> {
  if (node.type !== 'question' || typeof node.data.threadId !== 'string')
    return node;
  validateAgentNodeEditableData(node.data);
  const target = {
    canvasId,
    nodeId: node.id as CanvasNodeId,
    threadId: node.data.threadId,
  };
  const record = await agenetes.record(
    canvasAcpNamespace(canvasId),
    target.threadId,
  );
  if (record) {
    // Conversion transfers authority at canonical creation, using the latest
    // backend value rather than a potentially stale browser title cache.
    const title = effectiveConversationTitle(record);
    if (
      title.title &&
      node.data.labelSource !== 'user' &&
      node.data.labelSource !== 'agent'
    ) {
      node = {
        ...node,
        data: {
          ...node.data,
          label: title.title,
          labelSource: title.source === 'user' ? 'user' : 'auto',
          conversationTitleSource: title.source,
        },
      };
    }
    const binding = await agentNodeBinding.confirm(
      { ...target, bindingState: 'bound' },
      { required: true, alreadyLocked: true, record },
    );
    return {
      ...node,
      data: { ...node.data, bindingState: 'bound', agentBinding: binding },
    };
  }
  await agentNodeBinding.confirm(target, {
    alreadyLocked: true,
    required: requireBinding,
    record: null,
  });
  if (applyDefault && !node.data.agentBinding) {
    return {
      ...node,
      data: withDefaultAgentBinding(node.data),
    };
  }
  return node;
}

/** Retain nonblocking admission leases until the caller's Canvas write settles. */
export async function guardAgentNodeDraftEditsAlreadyLocked(
  canvasId: string,
  edits: readonly {
    current: EditableAgentNode;
    patch: Record<string, unknown>;
  }[],
): Promise<() => void> {
  const releases: Array<() => void> = [];
  const release = () => {
    for (const finish of releases.reverse()) finish();
  };
  try {
    for (const { current, patch } of edits) {
      if (current.type !== 'question') continue;
      validateAgentNodeEditableData(patch);
      if (
        !AGENT_NODE_PREPARATION_KEYS.some((key) =>
          Object.prototype.hasOwnProperty.call(patch, key),
        )
      )
        continue;
      const threadId = current.data?.threadId;
      if (typeof threadId !== 'string' || !threadId) continue;
      const target = await agentThreadResolver.resolveAgentNode(
        canvasId,
        threadId,
      );
      if (!target || target.nodeId !== current.id)
        throw new Error('Agent Node association changed');
      releases.push(await agentNodeBinding.guardDraftEdit(target, patch));
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
