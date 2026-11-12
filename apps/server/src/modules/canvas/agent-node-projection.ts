// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentNodeProjectionSchema,
  projectAgentNodeTransition,
  type AgentNodeProjection,
} from '@huabu/shared';

import {
  applyDeltasOnServerAlreadyLocked,
  hydrateCanvasNodes,
} from './canvas-executor.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import { withCanvasMutex } from './write-coordinator.js';
import { space } from '../storage/index.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

/** Project only durable activity boundaries, independently of viewing and geometry. */
export async function projectAgentConversationActivity(
  canvasId: string,
  threadId: string,
  lastActivityAt: number,
): Promise<void> {
  const lease = acquireWorkspaceOperationLease();
  try {
    await withCanvasMutex(canvasId, async () => {
      const canvas = await space(canvasId).read();
      for (const node of (canvas?.state.nodes ?? []) as CanvasNode[]) {
        if (
          node.type !== 'question' ||
          node.data.threadId !== threadId ||
          (typeof node.data.lastActivityAt === 'number' &&
            node.data.lastActivityAt >= lastActivityAt)
        )
          continue;
        if (
          !(await projectAgentNodeStateAlreadyLocked(canvasId, node.id, {
            threadId,
            lastActivityAt,
          }))
        )
          throw new Error('Conversation activity projection was rejected');
      }
    });
  } finally {
    lease.release();
  }
}

export async function projectAgentNodeState(
  canvasId: string,
  nodeId: string,
  transition: AgentNodeProjection,
): Promise<boolean> {
  const lease = acquireWorkspaceOperationLease();
  try {
    return await withCanvasMutex(canvasId, () =>
      projectAgentNodeStateAlreadyLocked(canvasId, nodeId, transition),
    );
  } finally {
    lease.release();
  }
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
  const record = await handle.nodes.read(nodeId);
  const node = hydrateCanvasNodes(
    record ? new Map([[nodeId, record]]) : new Map(),
    [stored],
  )[0];
  if (!node) return false;
  const data = projectAgentNodeTransition(node.data, parsed.data);
  if (!data) return false;
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
  const lease = acquireWorkspaceOperationLease();
  try {
    return await withCanvasMutex(canvasId, async () => {
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
  } finally {
    lease.release();
  }
}
