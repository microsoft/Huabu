// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import { AgenetesError } from '@agenetes/runtime';

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
import { getLogger } from '../../utils/logger.js';
import { buildReachbackEnv } from '../agent/acp/reachback-env.js';
import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  INTERNAL_DRIVER_KIND,
} from '../agent/agenetes/drivers.js';
import {
  agentNodeBinding,
  AgentNodeBindingError,
} from '../agent/agent-node-binding.js';
import { agentThreadResolver } from '../agent/agent-thread-resolver.js';
import { agentThreadService } from '../agent/agent-thread.service.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import {
  createSpace,
  deleteSpace,
  isWorldCanvasId,
  space,
} from '../storage/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { WorkloadSpec } from '@agenetes/protocol';

const log = getLogger('space-move');
const DIAGNOSTIC_CODES = new Set([
  'invalid_workload',
  'unknown_driver_kind',
  'unsupported_workload_type',
  'invalid_driver_spec',
  'invalid_driver_state',
  'invalid_driver_definition',
  'invalid_persisted_record',
  'thread_not_found',
  'invalid_host_metadata',
  'rehome_conflict',
  'rehome_unknown_outcome',
  'execution_record_missing',
  'execution_record_invalid',
  'agent_binding_conflict',
  'agent_draft_busy',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EIO',
  'ENOENT',
  'SQLITE_BUSY',
]);
const MOVE_MESSAGES: Record<MoveSelectionErrorCode, string> = {
  MOVE_SOURCE_STALE: 'Source Space changed before the move completed',
  MOVE_SOURCE_NODE_MISSING: 'The source selection was not found',
  MOVE_NODE_NOT_MOVABLE: 'The selection cannot be moved',
  MOVE_DESTINATION_MISSING: 'Destination Space was not found',
  MOVE_DESTINATION_SAME_AS_SOURCE:
    'Source and destination Spaces must be different',
  MOVE_DESTINATION_CREATE_FAILED: 'The destination Space could not be created',
  MOVE_DESTINATION_CLEANUP_FAILED:
    'Destination cleanup failed. Reload both Spaces before retrying',
  MOVE_WORLD_NOT_ALLOWED: 'World cannot participate in a move',
  MOVE_AGENT_RUNNING: 'An Agent in the selection is running or busy',
  MOVE_AGENT_TASK_OWNED: 'The selection contains an Agent owned by a Task Run',
  MOVE_AGENT_PENDING_CHANGES: 'An Agent in the selection has pending changes',
  MOVE_AGENT_HISTORY_INVALID:
    'An Agent has missing, invalid, or conflicting execution state',
  MOVE_AGENT_CLOSE_FAILED: 'An Agent runtime could not be closed',
  MOVE_AGENT_REHOME_FAILED: 'An Agent conversation could not be moved',
  MOVE_ARTIFACT_MISSING: 'A required artifact is missing',
  MOVE_DESTINATION_CONFLICT: 'The destination conflicts with the move',
  MOVE_COMPENSATION_FAILED:
    'Move compensation failed. Reload both Spaces before retrying',
  MOVE_OUTCOME_UNKNOWN:
    'The move outcome is unknown. Reload and reconcile both Spaces before retrying',
  MOVE_FAILED: 'The selection could not be moved',
};

export class SpaceMoveError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: MoveSelectionErrorCode,
    readonly statusCode = 409,
    options?: { cause: unknown },
  ) {
    super(MOVE_MESSAGES[code]);
    this.name = 'SpaceMoveError';
    this.cause = options?.cause;
  }
}

function moveFailure(error: unknown): SpaceMoveError {
  if (error instanceof SpaceMoveError) return error;
  if (error instanceof AgentNodeBindingError) {
    return new SpaceMoveError('MOVE_AGENT_HISTORY_INVALID', 409, {
      cause: error,
    });
  }
  if (error instanceof AgenetesError) {
    if (error.code === 'rehome_unknown_outcome') {
      return new SpaceMoveError('MOVE_OUTCOME_UNKNOWN', 500, { cause: error });
    }
    if (error.code === 'rehome_conflict') {
      return new SpaceMoveError('MOVE_DESTINATION_CONFLICT', 409, {
        cause: error,
      });
    }
    return new SpaceMoveError('MOVE_AGENT_HISTORY_INVALID', 409, {
      cause: error,
    });
  }
  return new SpaceMoveError('MOVE_FAILED', 500, { cause: error });
}

function failureKind(error: unknown): string {
  if (error instanceof AgenetesError) return 'agenetes';
  if (error instanceof AgentNodeBindingError) return 'binding';
  if (error instanceof SpaceMoveError && error.cause !== undefined) {
    return failureKind(error.cause);
  }
  return error instanceof SpaceMoveError ? 'move' : 'unexpected';
}

function upstreamFailureCode(error: unknown): string | undefined {
  if (error instanceof SpaceMoveError) return upstreamFailureCode(error.cause);
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    DIAGNOSTIC_CODES.has(error.code)
  )
    return error.code;
  return undefined;
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
  const destination = space(destinationCanvasId).artifacts;
  const cloned = new Map<string, string>();

  const cloneRef = async (raw: unknown): Promise<string | undefined> => {
    const ref = parseArtifactRef(raw);
    if (!ref) return undefined;
    const owner = ref.canvasId ?? sourceCanvasId;
    if (owner === destinationCanvasId) return ref.key;
    const cacheKey = `${owner}/${ref.key}`;
    const existing = cloned.get(cacheKey);
    if (existing) return existing;
    const body = await space(owner).artifacts.read(ref.key);
    if (!body) {
      throw new SpaceMoveError('MOVE_ARTIFACT_MISSING');
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
    throw new SpaceMoveError('MOVE_DESTINATION_SAME_AS_SOURCE');
  }
  if (isWorldCanvasId(sourceCanvasId) || isWorldCanvasId(destinationCanvasId)) {
    throw new SpaceMoveError('MOVE_WORLD_NOT_ALLOWED', 403);
  }

  const workspaceLease = acquireWorkspaceOperationLease();
  let createdDestination = false;
  let phase = 'destination-create';
  let compensation = 'not-needed';
  try {
    if (input.destination.kind === 'new') {
      const created = await createSpace(
        destinationCanvasId,
        input.destination.title,
      );
      if (!created.ok) {
        throw new SpaceMoveError('MOVE_DESTINATION_CREATE_FAILED');
      }
      createdDestination = true;
    }
    return await withCanvasMutexes(
      [sourceCanvasId, destinationCanvasId],
      async () => {
        phase = 'validation';
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
          throw new SpaceMoveError('MOVE_SOURCE_NODE_MISSING', 404);
        }
        if (!destination) {
          throw new SpaceMoveError('MOVE_DESTINATION_MISSING', 404);
        }
        if (source.version !== input.expectedSourceVersion) {
          throw new SpaceMoveError('MOVE_SOURCE_STALE');
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
            createSourcePreview: input.createSourcePreview,
          });
        } catch (error) {
          if (error instanceof SpaceMovePlanError) {
            const code =
              error.code === 'missing-node'
                ? 'MOVE_SOURCE_NODE_MISSING'
                : 'MOVE_NODE_NOT_MOVABLE';
            throw new SpaceMoveError(code, 409, { cause: error });
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
          throw new SpaceMoveError('MOVE_AGENT_TASK_OWNED');
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
              throw new SpaceMoveError('MOVE_AGENT_RUNNING');
            }
            const release = acquireAgentTurn(threadId);
            if (!release) {
              throw new SpaceMoveError('MOVE_AGENT_RUNNING');
            }
            releaseThreads.push(release);
            if ((await sourceHandle.changes.read(threadId)).length > 0) {
              throw new SpaceMoveError('MOVE_AGENT_PENDING_CHANGES');
            }
            const namespace = canvasAcpNamespace(sourceCanvasId);
            const record = await agenetes.record(namespace, threadId);
            if (!record) {
              const target = await agentThreadResolver.resolveAgentNode(
                sourceCanvasId,
                threadId,
              );
              if (!target)
                throw new SpaceMoveError('MOVE_AGENT_HISTORY_INVALID');
              await agentNodeBinding.confirm(target, { alreadyLocked: true });
              continue;
            }
            const target = await agentThreadResolver.resolveAgentNode(
              sourceCanvasId,
              threadId,
            );
            if (!target) throw new SpaceMoveError('MOVE_AGENT_HISTORY_INVALID');
            await agentNodeBinding.confirm(
              { ...target, bindingState: 'bound' },
              { required: true, alreadyLocked: true },
            );
            const movedNode = hydratedSource.find(
              (node) => node.data.threadId === threadId,
            );
            if (movedNode)
              movedNode.data = { ...movedNode.data, bindingState: 'bound' };
            threadMoves.push({
              threadId,
              sourceSpec: record.spec,
              targetSpec: movedWorkloadSpec(record.spec, destinationCanvasId),
            });
          }

          const movedNodes = hydratedSource.filter((node) =>
            plan.movedIds.has(node.id),
          );
          phase = 'artifacts';
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
            createSourcePreview: input.createSourcePreview,
          });

          phase = 'destination-write';
          const destinationWrite = await executeOnServerAlreadyLocked({
            canvasId: destinationCanvasId,
            commands: plan.commands,
            originator: { source: 'system' },
            publish: false,
            agentNodeMoveState: new Map(
              rewrittenNodes
                .filter((node) => node.type === 'question')
                .map((node) => {
                  const destinationId = plan.nodeIdMap.get(node.id);
                  if (!destinationId)
                    throw new SpaceMoveError('MOVE_AGENT_HISTORY_INVALID');
                  return [destinationId, node.data] as const;
                }),
            ),
          });
          const completedThreads: typeof threadMoves = [];
          let sourceWrite: ExecuteOnServerOutput | undefined;
          try {
            if (
              destinationWrite.results.some((result) => !result.applied) ||
              destinationWrite.toVersion === destinationWrite.fromVersion
            ) {
              throw new SpaceMoveError('MOVE_DESTINATION_CONFLICT');
            }
            for (const move of threadMoves) {
              phase = 'agent-close';
              try {
                await agenetes.close(move.threadId);
              } catch (error) {
                throw new SpaceMoveError('MOVE_AGENT_CLOSE_FAILED', 500, {
                  cause: error,
                });
              }
              phase = 'agent-rehome';
              try {
                await agenetes.rehome(
                  {
                    namespace: canvasAcpNamespace(sourceCanvasId),
                    threadId: move.threadId,
                  },
                  move.targetSpec,
                );
              } catch (error) {
                if (error instanceof AgenetesError) throw moveFailure(error);
                throw new SpaceMoveError('MOVE_AGENT_REHOME_FAILED', 500, {
                  cause: error,
                });
              }
              completedThreads.push(move);
            }
            phase = 'source-write';
            sourceWrite = await executeOnServerAlreadyLocked({
              canvasId: sourceCanvasId,
              commands: plan.sourceCommands,
              originator: { source: 'system' },
              publish: false,
            });
            if (sourceWrite.results.some((result) => !result.applied)) {
              throw new SpaceMoveError('MOVE_SOURCE_STALE');
            }
            phase = 'publication';
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
            const failure = moveFailure(error);
            if (failure.code === 'MOVE_OUTCOME_UNKNOWN') {
              compensation = 'not-attempted-unknown';
              throw failure;
            }
            try {
              compensation = 'threads';
              for (const move of completedThreads.reverse()) {
                await agenetes.rehome(
                  {
                    namespace: canvasAcpNamespace(destinationCanvasId),
                    threadId: move.threadId,
                  },
                  move.sourceSpec,
                );
              }
              compensation = 'source';
              if (sourceWrite && sourceWrite.deltas.length > 0) {
                await applyDeltasOnServerAlreadyLocked({
                  canvasId: sourceCanvasId,
                  deltas: invertDeltas(sourceWrite.deltas),
                  originator: { source: 'system' },
                  agentNodeMoveState: new Map(
                    movedNodes
                      .filter((node) => node.type === 'question')
                      .map((node) => [node.id, node.data]),
                  ),
                });
              }
              compensation = 'destination';
              await applyDeltasOnServerAlreadyLocked({
                canvasId: destinationCanvasId,
                deltas: invertDeltas(destinationWrite.deltas),
                originator: { source: 'system' },
              });
              compensation = 'succeeded';
            } catch (compensationError) {
              log.error(
                {
                  phase,
                  compensation,
                  code: 'MOVE_OUTCOME_UNKNOWN',
                  failureKind: failureKind(compensationError),
                  upstreamCode: upstreamFailureCode(compensationError),
                  originalCode: failure.code,
                },
                'Move compensation failed',
              );
              throw new SpaceMoveError('MOVE_OUTCOME_UNKNOWN', 500, {
                cause: { original: error, compensation: compensationError },
              });
            }
            throw failure;
          }
        } finally {
          for (const release of releaseThreads.reverse()) release();
        }
      },
    );
  } catch (error) {
    const failure = moveFailure(error);
    log.warn(
      {
        phase,
        compensation,
        code: failure.code,
        failureKind: failureKind(error),
        upstreamCode: upstreamFailureCode(error),
      },
      'Move rejected',
    );
    if (createdDestination && failure.code !== 'MOVE_OUTCOME_UNKNOWN') {
      try {
        const deleted = await deleteSpace(destinationCanvasId);
        if (!deleted.ok && deleted.reason !== 'not-found') {
          throw new Error(`cleanup rejected: ${deleted.reason}`);
        }
      } catch (cleanupError) {
        log.error(
          {
            phase: 'destination-cleanup',
            code: 'MOVE_DESTINATION_CLEANUP_FAILED',
            originalCode: failure.code,
            failureKind: failureKind(cleanupError),
            upstreamCode: upstreamFailureCode(cleanupError),
          },
          'Move destination cleanup failed',
        );
        throw new SpaceMoveError('MOVE_DESTINATION_CLEANUP_FAILED', 500, {
          cause: { original: error, cleanup: cleanupError },
        });
      }
    }
    throw failure;
  } finally {
    workspaceLease.release();
  }
}
