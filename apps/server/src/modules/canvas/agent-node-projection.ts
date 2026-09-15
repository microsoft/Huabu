// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentNodeProjectionSchema,
  type AgentNodeProjection,
} from '@huabu/shared';

import {
  applyDeltasOnServerAlreadyLocked,
  hydrateCanvasNodes,
} from './canvas-executor.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import { withCanvasMutex } from './write-coordinator.js';
import { space } from '../storage/index.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

export async function projectAgentNodeState(
  canvasId: string,
  nodeId: string,
  transition: AgentNodeProjection,
): Promise<boolean> {
  return withCanvasMutex(canvasId, () =>
    projectAgentNodeStateAlreadyLocked(canvasId, nodeId, transition),
  );
}

/** Caller owns the Canvas mutex; never acquire another lock from this entry. */
export async function projectAgentNodeStateAlreadyLocked(
  canvasId: string,
  nodeId: string,
  transition: AgentNodeProjection,
): Promise<boolean> {
  const parsed = agentNodeProjectionSchema.safeParse(transition);
  if (!parsed.success) throw new Error('Invalid Agent Node projection');
  const handle = space(canvasId);
  const canvas = await handle.read();
  const stored = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
    (node) => node.id === nodeId,
  );
  if (
    stored?.type !== 'question' ||
    stored.data.threadId !== transition.threadId
  )
    return false;
  if (
    transition.expectedInvocationToken !== undefined &&
    stored.data.invocationToken !== transition.expectedInvocationToken
  )
    return false;
  if (
    stored.data.bindingState === 'bound' &&
    transition.bindingState === 'editing'
  ) {
    throw new Error('An established Agent binding cannot be demoted');
  }
  const record = await handle.nodes.read(nodeId);
  const node = hydrateCanvasNodes(
    record ? new Map([[nodeId, record]]) : new Map(),
    [stored],
  )[0];
  if (!node) return false;
  const {
    threadId: _threadId,
    expectedInvocationToken: _expected,
    initialContent,
    ...patch
  } = parsed.data;
  const data: Record<string, unknown> = { ...node.data, ...patch };
  if (
    initialContent !== undefined &&
    !node.data.invocationToken &&
    typeof node.data.content === 'string' &&
    node.data.content.trim().length === 0
  )
    data.content = initialContent;
  const output = await applyDeltasOnServerAlreadyLocked({
    canvasId,
    deltas: [{ type: 'REPLACE_NODE', prev: node, next: { ...node, data } }],
    originator: { source: 'system' },
    agentNodeProjection: true,
  });
  if (output.toVersion > output.fromVersion) {
    publishCanvasUpdate(canvasId, {
      type: 'update',
      data: {
        fromVersion: output.fromVersion,
        toVersion: output.toVersion,
        deltas: output.deltas,
        pendingEffects: output.pendingEffects,
        agentNodeProjection: true,
      },
    });
  }
  return true;
}

export async function acknowledgeAgentNodeResult(
  canvasId: string,
  nodeId: string,
  invocationToken: string | null,
): Promise<boolean> {
  return withCanvasMutex(canvasId, async () => {
    const canvas = await space(canvasId).read();
    const node = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
      (item) => item.id === nodeId,
    );
    if (
      node?.type !== 'question' ||
      (node.data.invocationToken ?? null) !== invocationToken ||
      (node.data.status !== 'done' && node.data.status !== 'error') ||
      typeof node.data.threadId !== 'string'
    )
      return false;
    return projectAgentNodeStateAlreadyLocked(canvasId, nodeId, {
      threadId: node.data.threadId,
      ...(invocationToken !== null
        ? { expectedInvocationToken: invocationToken }
        : {}),
      viewed: true,
    });
  });
}
