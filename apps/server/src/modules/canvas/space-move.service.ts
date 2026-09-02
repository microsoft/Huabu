// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import {
  ARTIFACT_DATA_FIELDS,
  collectMarkdownArtifactRefs,
  createId,
  markdownArtifactFields,
  parseArtifactRef,
  rewriteMarkdownArtifactRefs,
  type MoveSelectionBody,
  type MoveSelectionErrorCode,
  type MoveSelectionResponse,
} from '@huabu/shared';
import {
  invertDeltas,
  type CanvasEdge,
  type CanvasNode,
} from '@huabu/shared/canvas-engine';

import {
  applyDeltasOnServerAlreadyLocked,
  executeOnServerAlreadyLocked,
  hydrateCanvasNodes,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import {
  buildSpaceMovePlan,
  SpaceMovePlanError,
  type SpaceMovePlan,
} from './space-move-plan.js';
import { withCanvasMutexes } from './write-coordinator.js';
import { buildReachbackEnv } from '../agent/acp/reachback-env.js';
import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  INTERNAL_DRIVER_KIND,
} from '../agent/agenetes/drivers.js';
import { agentThreadService } from '../agent/agent-thread.service.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import {
  createSpace,
  deleteSpace,
  getBlobStore,
  isWorldCanvasId,
  space,
} from '../storage/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { WorkloadSpec } from '@agenetes/protocol';

export class SpaceMoveError extends Error {
  constructor(
    readonly code: MoveSelectionErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SpaceMoveError';
  }
}

function movedWorkloadSpec(
  source: WorkloadSpec,
  destinationCanvasId: string,
): WorkloadSpec {
  const cloned =
    source.spec && typeof source.spec === 'object'
      ? structuredClone(source.spec as Record<string, unknown>)
      : source.spec;
  if (cloned && typeof cloned === 'object') {
    const spec = cloned as Record<string, unknown>;
    if (source.kind === INTERNAL_DRIVER_KIND) {
      const hostContext =
        spec.hostContext && typeof spec.hostContext === 'object'
          ? spec.hostContext
          : {};
      spec.hostContext = { ...hostContext, canvasId: destinationCanvasId };
    } else if (source.kind === EXTERNAL_DRIVER_KIND) {
      spec.env = {
        ...(spec.env && typeof spec.env === 'object' ? spec.env : {}),
        ...buildReachbackEnv(source.threadId, destinationCanvasId),
      };
    }
  }
  return {
    ...source,
    namespace: canvasAcpNamespace(destinationCanvasId),
    spec: cloned,
  };
}

async function cloneArtifacts(
  sourceCanvasId: string,
  destinationCanvasId: string,
  nodes: readonly CanvasNode[],
): Promise<CanvasNode[]> {
  const blobs = getBlobStore();
  const destination = blobs.scope({
    kind: 'canvas',
    canvasId: destinationCanvasId,
  });
  const cloned = new Map<string, string>();

  const cloneRef = async (raw: unknown): Promise<string | undefined> => {
    const ref = parseArtifactRef(raw);
    if (!ref) return undefined;
    const owner = ref.canvasId ?? sourceCanvasId;
    if (owner === destinationCanvasId) return ref.key;
    const cacheKey = `${owner}/${ref.key}`;
    const existing = cloned.get(cacheKey);
    if (existing) return existing;
    const body = await blobs
      .scope({ kind: 'canvas', canvasId: owner })
      .read(ref.key);
    if (!body) {
      throw new SpaceMoveError(
        'MOVE_ARTIFACT_MISSING',
        `Required artifact is missing: ${ref.key}`,
      );
    }
    const key = `${createId('artifact')}${path.extname(ref.key)}`;
    await destination.put(key, body);
    cloned.set(cacheKey, key);
    return key;
  };

  return Promise.all(
    nodes.map(async (node) => {
      const data = structuredClone(
        (node.data ?? {}) as Record<string, unknown>,
      );
      for (const field of ARTIFACT_DATA_FIELDS) {
        const key = await cloneRef(data[field]);
        if (key) data[field] = key;
      }
      for (const field of markdownArtifactFields(data)) {
        const markdown = data[field];
        if (typeof markdown !== 'string') continue;
        const rewrites = new Map<string, string>();
        await Promise.all(
          collectMarkdownArtifactRefs(markdown).map(async (raw) => {
            const key = await cloneRef(raw);
            if (key) rewrites.set(raw, key);
          }),
        );
        data[field] = rewriteMarkdownArtifactRefs(markdown, (raw) =>
          rewrites.get(raw),
        );
      }
      return { ...node, data };
    }),
  );
}

function publishExecution(output: ExecuteOnServerOutput): void {
  if (output.toVersion === output.fromVersion) return;
  publishCanvasUpdate(output.canvasId, {
    type: 'update',
    data: {
      fromVersion: output.fromVersion,
      toVersion: output.toVersion,
      deltas: output.deltas,
      pendingEffects: output.pendingEffects,
    },
  });
}

export async function moveCanvasSelection(
  sourceCanvasId: string,
  input: MoveSelectionBody,
): Promise<MoveSelectionResponse> {
  const destinationCanvasId =
    input.destination.kind === 'existing'
      ? input.destination.canvasId
      : createId('canvas');
  if (sourceCanvasId === destinationCanvasId) {
    throw new SpaceMoveError(
      'MOVE_DESTINATION_SAME_AS_SOURCE',
      'Source and destination Spaces must be different',
    );
  }
  if (isWorldCanvasId(sourceCanvasId) || isWorldCanvasId(destinationCanvasId)) {
    throw new SpaceMoveError(
      'MOVE_WORLD_NOT_ALLOWED',
      'World cannot participate in a move',
      403,
    );
  }

  const workspaceLease = acquireWorkspaceOperationLease();
  let createdDestination = false;
  try {
    if (input.destination.kind === 'new') {
      const created = await createSpace(
        destinationCanvasId,
        input.destination.title,
      );
      if (!created.ok) {
        throw new SpaceMoveError(
          'MOVE_DESTINATION_CREATE_FAILED',
          'The destination Space could not be created',
        );
      }
      createdDestination = true;
    }
    return await withCanvasMutexes(
      [sourceCanvasId, destinationCanvasId],
      async () => {
        const sourceHandle = space(sourceCanvasId);
        const destinationHandle = space(destinationCanvasId);
        const [source, destination, sourceRecords, destinationRecords] =
          await Promise.all([
            sourceHandle.read(),
            destinationHandle.read(),
            sourceHandle.nodes.list(),
            destinationHandle.nodes.list(),
          ]);
        if (!source) {
          throw new SpaceMoveError(
            'MOVE_SOURCE_NODE_MISSING',
            'Source Space was not found',
            404,
          );
        }
        if (!destination) {
          throw new SpaceMoveError(
            'MOVE_DESTINATION_MISSING',
            'Destination Space was not found',
            404,
          );
        }
        if (source.version !== input.expectedSourceVersion) {
          throw new SpaceMoveError(
            'MOVE_SOURCE_STALE',
            'Source Space changed before the move started',
          );
        }

        const hydratedSource = hydrateCanvasNodes(
          sourceRecords,
          source.state.nodes as CanvasNode[],
        );
        const hydratedDestination = hydrateCanvasNodes(
          destinationRecords,
          destination.state.nodes as CanvasNode[],
        );
        let plan: SpaceMovePlan;
        try {
          plan = buildSpaceMovePlan({
            sourceNodes: hydratedSource,
            sourceEdges: (source.state.edges ?? []) as CanvasEdge[],
            destinationNodes: hydratedDestination,
            selectedNodeIds: input.selectedNodeIds,
            destinationCanvasId,
          });
        } catch (error) {
          if (error instanceof SpaceMovePlanError) {
            const code =
              error.code === 'missing-node'
                ? 'MOVE_SOURCE_NODE_MISSING'
                : 'MOVE_NODE_NOT_MOVABLE';
            throw new SpaceMoveError(code, error.message);
          }
          throw error;
        }

        const taskSnapshot = await sourceHandle.tasks.read();
        if (
          taskSnapshot.runs.some(
            (run) =>
              (run.rootNodeId && plan.movedIds.has(run.rootNodeId)) ||
              (run.rootThreadId &&
                plan.movedThreadIds.includes(run.rootThreadId)),
          )
        ) {
          throw new SpaceMoveError(
            'MOVE_AGENT_TASK_OWNED',
            'The selection contains an Agent owned by a Task Run',
          );
        }
        const releaseThreads: Array<() => void> = [];
        const threadMoves: Array<{
          threadId: string;
          sourceSpec: WorkloadSpec;
          targetSpec: WorkloadSpec;
        }> = [];
        try {
          for (const threadId of plan.movedThreadIds) {
            if (agentThreadService.isActive(threadId, sourceCanvasId)) {
              throw new SpaceMoveError(
                'MOVE_AGENT_RUNNING',
                `Agent conversation ${threadId} is running`,
              );
            }
            const release = acquireAgentTurn(threadId);
            if (!release) {
              throw new SpaceMoveError(
                'MOVE_AGENT_RUNNING',
                `Agent conversation ${threadId} is busy`,
              );
            }
            releaseThreads.push(release);
            if ((await sourceHandle.changes.read(threadId)).length > 0) {
              throw new SpaceMoveError(
                'MOVE_AGENT_PENDING_CHANGES',
                `Agent conversation ${threadId} has pending changes`,
              );
            }
            const namespace = canvasAcpNamespace(sourceCanvasId);
            const record = agenetes.record(namespace, threadId);
            if (!record) {
              throw new SpaceMoveError(
                'MOVE_AGENT_HISTORY_INVALID',
                `Agent conversation ${threadId} has no durable record`,
              );
            }
            threadMoves.push({
              threadId,
              sourceSpec: record.spec,
              targetSpec: movedWorkloadSpec(record.spec, destinationCanvasId),
            });
          }

          const movedNodes = hydratedSource.filter((node) =>
            plan.movedIds.has(node.id),
          );
          const rewrittenNodes = await cloneArtifacts(
            sourceCanvasId,
            destinationCanvasId,
            movedNodes,
          );
          const rewrittenById = new Map(
            rewrittenNodes.map((node) => [node.id, node]),
          );
          plan = buildSpaceMovePlan({
            sourceNodes: hydratedSource.map(
              (node) => rewrittenById.get(node.id) ?? node,
            ),
            sourceEdges: (source.state.edges ?? []) as CanvasEdge[],
            destinationNodes: hydratedDestination,
            selectedNodeIds: input.selectedNodeIds,
            destinationCanvasId,
          });

          const destinationWrite = await executeOnServerAlreadyLocked({
            canvasId: destinationCanvasId,
            commands: plan.commands,
            originator: { source: 'system' },
            publish: false,
          });
          if (
            destinationWrite.results.some((result) => !result.applied) ||
            destinationWrite.toVersion === destinationWrite.fromVersion
          ) {
            throw new SpaceMoveError(
              'MOVE_DESTINATION_CONFLICT',
              'Destination rejected the moved nodes',
            );
          }

          const completedThreads: typeof threadMoves = [];
          let sourceWrite: ExecuteOnServerOutput | undefined;
          try {
            for (const move of threadMoves) {
              agenetes.rehome(
                {
                  namespace: canvasAcpNamespace(sourceCanvasId),
                  threadId: move.threadId,
                },
                move.targetSpec,
              );
              completedThreads.push(move);
            }
            sourceWrite = await executeOnServerAlreadyLocked({
              canvasId: sourceCanvasId,
              commands: plan.sourceCommands,
              originator: { source: 'system' },
              publish: false,
            });
            if (sourceWrite.results.some((result) => !result.applied)) {
              throw new SpaceMoveError(
                'MOVE_SOURCE_STALE',
                'Source rejected deletion of the moved nodes',
              );
            }
            publishExecution(destinationWrite);
            publishExecution(sourceWrite);
            const create = plan.commands.find(
              (command) => command.type === 'CREATE_NODES',
            );
            return {
              transferId: createId('transfer'),
              destination: {
                canvasId: destinationCanvasId,
                title: destination.title,
                created: createdDestination,
              },
              sourcePreviewNodeId: plan.sourcePreviewNodeId,
              sourceVersion: sourceWrite.toVersion,
              destinationVersion: destinationWrite.toVersion,
              roots:
                create?.type === 'CREATE_NODES'
                  ? plan.rootIds.flatMap((sourceNodeId) => {
                      const destinationNodeId =
                        plan.nodeIdMap.get(sourceNodeId);
                      if (!destinationNodeId) return [];
                      const node = create.nodes.find(
                        (candidate) => candidate.id === destinationNodeId,
                      );
                      return [
                        {
                          sourceNodeId,
                          destinationNodeId,
                          label:
                            typeof node?.data?.label === 'string'
                              ? node.data.label
                              : '',
                        },
                      ];
                    })
                  : [],
              movedNodeCount: plan.movedIds.size,
              movedFrameCount: plan.movedFrameCount,
              preservedEdgeCount:
                plan.commands.find(
                  (command) => command.type === 'CONNECT_NODES',
                )?.type === 'CONNECT_NODES'
                  ? (
                      plan.commands.find(
                        (command) => command.type === 'CONNECT_NODES',
                      ) as Extract<
                        (typeof plan.commands)[number],
                        { type: 'CONNECT_NODES' }
                      >
                    ).edges.length
                  : 0,
              omittedBoundaryEdges: plan.omittedBoundaryEdges,
              renamedNodes: plan.renamedNodes,
              movedConversationCount: threadMoves.length,
            };
          } catch (error) {
            try {
              if (sourceWrite && sourceWrite.deltas.length > 0) {
                await applyDeltasOnServerAlreadyLocked({
                  canvasId: sourceCanvasId,
                  deltas: invertDeltas(sourceWrite.deltas),
                  originator: { source: 'system' },
                });
              }
              for (const move of completedThreads.reverse()) {
                agenetes.rehome(
                  {
                    namespace: canvasAcpNamespace(destinationCanvasId),
                    threadId: move.threadId,
                  },
                  move.sourceSpec,
                );
              }
              await applyDeltasOnServerAlreadyLocked({
                canvasId: destinationCanvasId,
                deltas: invertDeltas(destinationWrite.deltas),
                originator: { source: 'system' },
              });
            } catch (compensationError) {
              throw new SpaceMoveError(
                'MOVE_OUTCOME_UNKNOWN',
                `Move failed and compensation also failed: ${String(compensationError)}`,
                500,
              );
            }
            throw error;
          }
        } finally {
          for (const release of releaseThreads.reverse()) release();
        }
      },
    );
  } catch (error) {
    if (
      createdDestination &&
      !(
        error instanceof SpaceMoveError && error.code === 'MOVE_OUTCOME_UNKNOWN'
      )
    ) {
      try {
        const deleted = await deleteSpace(destinationCanvasId);
        if (!deleted.ok && deleted.reason !== 'not-found') {
          throw new Error(`cleanup rejected: ${deleted.reason}`);
        }
      } catch (cleanupError) {
        throw new SpaceMoveError(
          'MOVE_DESTINATION_CLEANUP_FAILED',
          `Move failed and the new destination Space could not be removed: ${String(cleanupError)}`,
          500,
        );
      }
    }
    throw error;
  } finally {
    workspaceLease.release();
  }
}
