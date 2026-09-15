// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createId } from '@huabu/shared';
import { projectAgentNodeEditableData } from '@huabu/shared/canvas-engine';

import { initializeAgentNodeCreationAlreadyLocked } from './agent-node-edit.js';
import {
  applyDeltasOnServerAlreadyLocked,
  hydrateCanvasNodes,
} from './canvas-executor.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import { withCanvasMutex } from './write-coordinator.js';
import { space } from '../storage/index.js';

import type {
  AssociateAgentNodeBody,
  AssociateAgentNodeResponse,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

export class AgentNodeAssociationError extends Error {}

/** Explicit identity creation, never an existing-node thread replacement. */
export async function associateAgentNode(
  canvasId: string,
  nodeId: string,
  body: AssociateAgentNodeBody,
): Promise<AssociateAgentNodeResponse> {
  return withCanvasMutex(canvasId, async () => {
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) throw new AgentNodeAssociationError('Space no longer exists');
    const nodes = canvas.state.nodes as CanvasNode[];
    const stored = nodes.find((node) => node.id === nodeId);
    if (stored && stored.type !== 'question')
      throw new AgentNodeAssociationError('The node is not an Agent Node');
    if (body.kind === 'restore' && body.node.id !== nodeId)
      throw new AgentNodeAssociationError(
        'Restored node identity does not match',
      );
    if (stored?.data.threadId) {
      if (body.kind === 'restore' && stored.data.threadId !== body.threadId)
        throw new AgentNodeAssociationError(
          'An existing Agent Node cannot be rebound',
        );
      const record = await handle.nodes.read(nodeId);
      const node =
        hydrateCanvasNodes(record ? new Map([[nodeId, record]]) : new Map(), [
          stored,
        ])[0] ?? stored;
      return { node, fromVersion: canvas.version, toVersion: canvas.version };
    }
    if (body.kind === 'initialize' && !stored)
      throw new AgentNodeAssociationError('Agent Node no longer exists');
    if (
      stored?.data.bindingState === 'bound' ||
      stored?.data.invocationToken ||
      (stored?.data.status !== undefined && stored.data.status !== 'idle')
    )
      throw new AgentNodeAssociationError(
        'Agent Node execution identity is missing',
      );
    // A restore cannot attach a supplied thread to an existing legacy node.
    if (body.kind === 'restore' && stored)
      throw new AgentNodeAssociationError(
        'An existing Agent Node cannot be rebound',
      );
    const threadId =
      body.kind === 'restore'
        ? (body.threadId ?? createId('thread'))
        : createId('thread');
    if (
      nodes.some(
        (node) => node.type === 'question' && node.data.threadId === threadId,
      )
    )
      throw new AgentNodeAssociationError(
        'The thread already belongs to an Agent Node',
      );
    const record = stored ? await handle.nodes.read(nodeId) : undefined;
    const previous = stored
      ? (hydrateCanvasNodes(record ? new Map([[nodeId, record]]) : new Map(), [
          stored,
        ])[0] ?? stored)
      : undefined;
    const source =
      previous ?? (body.kind === 'restore' ? body.node : undefined);
    if (!source)
      throw new AgentNodeAssociationError('Agent Node no longer exists');
    const node = await initializeAgentNodeCreationAlreadyLocked(
      canvasId,
      {
        ...source,
        data: {
          ...projectAgentNodeEditableData(source.data ?? {}),
          threadId,
          bindingState: 'editing',
        },
      } as CanvasNode,
      body.kind === 'restore' && body.requireBinding,
    );
    const output = await applyDeltasOnServerAlreadyLocked({
      canvasId,
      deltas: previous
        ? [{ type: 'REPLACE_NODE', prev: previous, next: node }]
        : [{ type: 'INSERT_NODE', node }],
      originator: { source: 'ui' },
      agentNodeProjection: true,
    });
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
    return {
      node,
      fromVersion: output.fromVersion,
      toVersion: output.toVersion,
    };
  });
}
