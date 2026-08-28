// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentBindingSchema, getQuestionNodeStatus } from '@huabu/shared';

import { describeNode } from './node-prompt.js';
import { readWorldTargetCanvasesStrict } from './world-target-access.js';
import { getStructuredStore, space } from '../storage/index.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { CanvasFile, NodeContent } from '../storage/index.js';
import type {
  CanvasNodeType,
  GetWorldReferencesResponse,
  ResolvedWorldReference,
} from '@huabu/shared';

interface StoredNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

export class WorldReferenceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldReferenceResolutionError';
  }
}

interface SourceCanvas {
  canvas: CanvasFile | null;
  content?: Map<string, NodeContent>;
}

/** Resolve every persistent World reference into a non-persistent read model. */
export async function resolveWorldReferences(
  worldCanvasId: string,
): Promise<GetWorldReferencesResponse> {
  const workspaceLease = acquireWorkspaceOperationLease();
  try {
    if (worldCanvasId !== (await getStructuredStore().spaces().worldId())) {
      throw new WorldReferenceResolutionError(
        'References can be resolved only for the World Canvas',
      );
    }
    const world = await space(worldCanvasId).read();
    if (!world) {
      throw new WorldReferenceResolutionError('World Canvas is not readable');
    }

    const nodes = world.state.nodes as StoredNode[];
    const sourceCanvasIds = new Set<string>();
    for (const node of nodes) {
      if (node.type === 'canvasRef') {
        const targetCanvasId = node.data?.targetCanvasId;
        if (typeof targetCanvasId !== 'string') {
          throw new WorldReferenceResolutionError(
            `Portal ${node.id} has no valid targetCanvasId`,
          );
        }
        sourceCanvasIds.add(targetCanvasId);
      } else if (node.type === 'nodeRef' || node.type === 'frameRef') {
        const target = node.data?.target as Record<string, unknown> | undefined;
        if (
          typeof target?.canvasId !== 'string' ||
          typeof target.nodeId !== 'string'
        ) {
          throw new WorldReferenceResolutionError(
            `Node reference ${node.id} has no valid target`,
          );
        }
        sourceCanvasIds.add(target.canvasId);
      }
    }

    const sources = new Map<string, SourceCanvas>();
    const sourceCanvases = await readWorldTargetCanvasesStrict(sourceCanvasIds);
    await Promise.all(
      [...sourceCanvasIds].map(async (canvasId) => {
        const canvas = sourceCanvases.get(canvasId) ?? null;
        if (!canvas) {
          sources.set(canvasId, { canvas: null });
          return;
        }
        // A reference can address any node in the source Space, and the
        // references are discovered as the World topology is walked below, so
        // the source's nodes are read whole rather than per reference.
        const records = await space(canvasId).nodes.list();
        const content = new Map<string, NodeContent>();
        for (const [nodeId, snapshot] of records) {
          content.set(nodeId, snapshot.record);
        }
        sources.set(canvasId, { canvas, content });
      }),
    );

    const references: ResolvedWorldReference[] = [];
    for (const node of nodes) {
      if (node.type === 'canvasRef') {
        const targetCanvasId = node.data?.targetCanvasId as string;
        const canvas = sources.get(targetCanvasId)?.canvas;
        references.push({
          kind: 'canvasRef',
          referenceNodeId: node.id as `node-${string}`,
          targetCanvasId: targetCanvasId as `canvas-${string}`,
          status: canvas ? 'ok' : 'canvas-missing',
          ...(canvas ? { title: canvas.title } : {}),
        });
        continue;
      }
      if (node.type !== 'nodeRef' && node.type !== 'frameRef') continue;

      const target = node.data?.target as { canvasId: string; nodeId: string };
      const kind = node.type;
      const source = sources.get(target.canvasId);
      if (!source?.canvas) {
        references.push({
          kind,
          referenceNodeId: node.id as `node-${string}`,
          target: {
            canvasId: target.canvasId as `canvas-${string}`,
            nodeId: target.nodeId as `node-${string}`,
          },
          status: 'canvas-missing',
        });
        continue;
      }

      const sourceNode = (source.canvas.state.nodes as StoredNode[]).find(
        (candidate) => candidate.id === target.nodeId,
      );
      if (!sourceNode) {
        references.push({
          kind,
          referenceNodeId: node.id as `node-${string}`,
          target: {
            canvasId: target.canvasId as `canvas-${string}`,
            nodeId: target.nodeId as `node-${string}`,
          },
          status: 'node-missing',
        });
        continue;
      }

      const sourceContent = source.content?.get(target.nodeId) ?? null;
      const resolved = describeNode(
        {
          id: target.nodeId,
          type: sourceNode.type as CanvasNodeType,
        },
        'preview',
        sourceContent,
      );
      const sourceData = sourceNode.data ?? {};
      const agentBinding =
        sourceNode.type === 'question'
          ? agentBindingSchema.safeParse(sourceData.agentBinding)
          : null;
      references.push({
        kind,
        referenceNodeId: node.id as `node-${string}`,
        target: {
          canvasId: target.canvasId as `canvas-${string}`,
          nodeId: target.nodeId as `node-${string}`,
        },
        status: 'ok',
        source: {
          type: resolved.type,
          ...(resolved.label ? { label: resolved.label } : {}),
          ...(resolved.summary ? { summary: resolved.summary } : {}),
          ...(resolved.preview ? { preview: resolved.preview } : {}),
          ...(resolved.rev ? { rev: resolved.rev } : {}),
          ...(sourceNode.type === 'question'
            ? {
                ...(typeof sourceData.threadId === 'string' &&
                sourceData.threadId.length > 0
                  ? { threadId: sourceData.threadId }
                  : {}),
                status: getQuestionNodeStatus(sourceData),
                viewed: sourceData.viewed === true,
                agentMode:
                  sourceData.agentMode === 'operate' ? 'operate' : 'ask',
                agentBinding: agentBinding?.success
                  ? agentBinding.data
                  : { kind: 'internal' },
                hasAuthoredContent:
                  typeof sourceContent?.content === 'string' &&
                  sourceContent.content.trim().length > 0,
              }
            : {}),
        },
      });
    }

    return { references };
  } finally {
    workspaceLease.release();
  }
}
