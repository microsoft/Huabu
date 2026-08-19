// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  createId,
  interactiveViewDefinitionV1Schema,
  interactiveViewJsonRevision,
  interactiveViewRevision,
  validateInteractiveViewJsonBounds,
  validateInteractiveViewStateSchema,
  validateInteractiveViewState,
  type CanvasNodeId,
  type CreateInteractiveViewRequest,
  type InteractiveViewDefinitionV1,
  type InteractiveViewJsonValue,
  type InteractiveViewResource,
  type InteractiveViewRuntimeSnapshot,
} from '@huabu/shared';

import { createInteractiveViewSubmission } from '../agent/agenetes/handle.js';
import { AgentThreadResolutionError } from '../agent/agent-thread-resolver.js';
import {
  AgentThreadBusyError,
  agentThreadService,
  type ExternalAgentThreadTarget,
} from '../agent/agent-thread.service.js';
import { safeResolve } from '../agent/tools/handlers/fs-sandbox.js';
import {
  executeOnServer,
  type InteractiveViewConflict,
} from '../canvas/canvas-executor.js';
import { space, getStructuredStore } from '../storage/index.js';

import type { NodeContent } from '../storage/index.js';
import type { FastifyBaseLogger } from 'fastify';

interface StoredNode {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}

const STAGED_RENDERER_ARTIFACT_RE =
  /^upload\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.html?)$/i;

export type InteractiveViewServiceErrorCode =
  | 'canvas_not_found'
  | 'renderer_not_found'
  | 'invalid_owner_thread'
  | 'invalid_definition'
  | 'invalid_state'
  | 'view_not_found'
  | 'view_conflict'
  | 'action_not_granted'
  | 'action_not_available'
  | 'thread_busy'
  | 'view_create_failed'
  | 'view_update_failed';

export class InteractiveViewServiceError extends Error {
  constructor(
    public readonly code: InteractiveViewServiceErrorCode,
    message: string,
    public readonly conflict?: InteractiveViewConflict,
  ) {
    super(message);
    this.name = 'InteractiveViewServiceError';
  }
}

async function resolveOwnerThread(
  canvasId: string,
  threadId: string,
): Promise<ExternalAgentThreadTarget | null> {
  try {
    return await agentThreadService.resolveExternalTarget(canvasId, threadId);
  } catch (error) {
    if (error instanceof AgentThreadResolutionError) {
      throw new InteractiveViewServiceError(
        'invalid_owner_thread',
        `Owner thread ${threadId} is invalid in this Canvas: ${error.message}`,
      );
    }
    throw error;
  }
}

function stagedRendererPath(
  canvasId: string,
  rendererArtifact: string,
): string | null {
  const match = STAGED_RENDERER_ARTIFACT_RE.exec(rendererArtifact);
  const filename = match?.[1];
  if (!filename) return null;
  const uploadRoot = safeResolve(canvasId, '.upload');
  const candidate = path.resolve(uploadRoot, filename);
  if (!candidate.startsWith(uploadRoot + path.sep)) return null;
  return candidate;
}

function validateDefinition(definition: InteractiveViewDefinitionV1): void {
  const schemaIssue = validateInteractiveViewStateSchema(
    definition.state.schema,
  );
  if (schemaIssue) {
    throw new InteractiveViewServiceError('invalid_definition', schemaIssue);
  }
  const stateIssue = validateInteractiveViewState(
    definition.state.schema,
    definition.state.value,
  );
  if (stateIssue) {
    throw new InteractiveViewServiceError('invalid_state', stateIssue);
  }

  const bindingIds = new Set<string>();
  for (const binding of definition.bindings) {
    if (bindingIds.has(binding.bindingId)) {
      throw new InteractiveViewServiceError(
        'invalid_definition',
        `Duplicate bindingId "${binding.bindingId}"`,
      );
    }
    bindingIds.add(binding.bindingId);
  }

  const actionIds = new Set<string>();
  for (const action of definition.actions) {
    if (actionIds.has(action.actionId)) {
      throw new InteractiveViewServiceError(
        'invalid_definition',
        `Duplicate actionId "${action.actionId}"`,
      );
    }
    actionIds.add(action.actionId);
    if (action.bindingId && !bindingIds.has(action.bindingId)) {
      throw new InteractiveViewServiceError(
        'invalid_definition',
        `Action "${action.actionId}" references unknown binding "${action.bindingId}"`,
      );
    }
    if (
      (action.kind === 'data.refresh' ||
        action.kind === 'navigation.open-node' ||
        action.kind === 'navigation.open-thread') &&
      !action.bindingId
    ) {
      throw new InteractiveViewServiceError(
        'invalid_definition',
        `Action "${action.actionId}" requires a bindingId`,
      );
    }
  }
}

function resourceFromNode(
  node: StoredNode,
  record: NodeContent | null,
): InteractiveViewResource | null {
  if (node.type !== 'web' || typeof node.id !== 'string') return null;
  const data =
    node.data && typeof node.data === 'object'
      ? (node.data as Record<string, unknown>)
      : {};
  const parsed = interactiveViewDefinitionV1Schema.safeParse(
    data.interactiveView,
  );
  if (!parsed.success) return null;
  const rendererArtifact =
    typeof record?.src === 'string'
      ? record.src
      : typeof data.src === 'string'
        ? data.src
        : null;
  if (!rendererArtifact) return null;
  return {
    nodeId: node.id,
    ...(typeof data.viewKey === 'string' ? { viewKey: data.viewKey } : {}),
    rendererArtifact,
    revision: interactiveViewRevision(parsed.data),
    definition: parsed.data,
  };
}

export class InteractiveViewService {
  async list(
    canvasId: string,
    viewKey?: string,
  ): Promise<InteractiveViewResource[]> {
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) {
      throw new InteractiveViewServiceError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }
    // Every `web` node is a candidate View and each needs its record's `src`,
    // so the candidate set is the Space.
    const records = await handle.nodes.list();
    return (canvas.state.nodes as StoredNode[]).flatMap((node) => {
      const resource = resourceFromNode(
        node,
        typeof node.id === 'string'
          ? (records.get(node.id)?.record ?? null)
          : null,
      );
      if (
        !resource ||
        (viewKey !== undefined && resource.viewKey !== viewKey)
      ) {
        return [];
      }
      return [resource];
    });
  }

  async get(
    canvasId: string,
    nodeId: string,
  ): Promise<InteractiveViewResource> {
    const handle = space(canvasId);
    const canvas = await handle.read();
    if (!canvas) {
      throw new InteractiveViewServiceError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }
    const node = (canvas.state.nodes as StoredNode[]).find(
      (candidate) => candidate.id === nodeId,
    );
    const resource = node
      ? resourceFromNode(
          node,
          (await handle.nodes.read(nodeId))?.record ?? null,
        )
      : null;
    if (!resource) {
      throw new InteractiveViewServiceError(
        'view_not_found',
        `Interactive View ${nodeId} does not exist`,
      );
    }
    return resource;
  }

  async runtimeSnapshot(
    canvasId: string,
    nodeId: string,
  ): Promise<InteractiveViewRuntimeSnapshot> {
    const resource = await this.get(canvasId, nodeId);
    const data: InteractiveViewRuntimeSnapshot['data'] = {};
    for (const binding of resource.definition.bindings) {
      let value: InteractiveViewJsonValue;
      const nodeIds = new Set<string>();
      const threadIds = new Set<string>();
      if (binding.source.kind === 'canvas.task-store') {
        const snapshot = await getStructuredStore()
          .space(canvasId)
          .tasks.read();
        const runs = [...snapshot.runs]
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, binding.source.recentRunLimit);
        value = {
          tasks: snapshot.tasks.map((task) => ({
            taskId: task.taskId,
            goal: task.goal,
            defaultRootProfileId: task.defaultRootProfileId,
            anchorNodeId: task.anchorNodeId,
            createdAt: task.createdAt,
          })),
          runs: runs.map((run) => ({
            runId: run.runId,
            taskId: run.taskId,
            goal: run.goalSnapshot,
            rootProfileId: run.rootProfileIdSnapshot,
            status: run.status,
            ...(run.rootNodeId ? { rootNodeId: run.rootNodeId } : {}),
            ...(run.rootThreadId ? { rootThreadId: run.rootThreadId } : {}),
            createdAt: run.createdAt,
            ...(run.startedAt ? { startedAt: run.startedAt } : {}),
            ...(run.completion ? { completion: run.completion } : {}),
          })),
        };
        for (const task of snapshot.tasks) {
          if (task.anchorNodeId) nodeIds.add(task.anchorNodeId);
        }
        for (const run of runs) {
          if (run.rootNodeId) nodeIds.add(run.rootNodeId);
          if (run.rootThreadId) threadIds.add(run.rootThreadId);
        }
      } else {
        const canvas = await space(canvasId).read();
        if (!canvas) {
          throw new InteractiveViewServiceError(
            'canvas_not_found',
            `Canvas ${canvasId} does not exist`,
          );
        }
        const requested = new Set(binding.source.nodeIds);
        value = (canvas.state.nodes as StoredNode[]).flatMap((node) => {
          if (typeof node.id !== 'string' || !requested.has(node.id)) return [];
          const nodeData =
            node.data && typeof node.data === 'object'
              ? (node.data as Record<string, unknown>)
              : {};
          nodeIds.add(node.id);
          if (typeof nodeData.threadId === 'string') {
            threadIds.add(nodeData.threadId);
          }
          return [
            {
              nodeId: node.id,
              type: typeof node.type === 'string' ? node.type : 'unknown',
              ...(typeof nodeData.label === 'string'
                ? { label: nodeData.label }
                : {}),
              ...(typeof nodeData.summary === 'string'
                ? { summary: nodeData.summary }
                : {}),
              ...(typeof nodeData.threadId === 'string'
                ? { threadId: nodeData.threadId }
                : {}),
            },
          ];
        });
      }
      data[binding.bindingId] = {
        revision: interactiveViewJsonRevision('binding', value),
        value,
        references: {
          nodeIds: [...nodeIds],
          threadIds: [...threadIds],
        },
      };
    }
    return { resource, data };
  }

  async create(
    canvasId: string,
    request: CreateInteractiveViewRequest,
  ): Promise<InteractiveViewResource> {
    const canvas = await space(canvasId).read();
    if (!canvas) {
      throw new InteractiveViewServiceError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }
    if (!(await resolveOwnerThread(canvasId, request.ownerThreadId))) {
      throw new InteractiveViewServiceError(
        'invalid_owner_thread',
        `Owner thread ${request.ownerThreadId} is not an external Agent thread in this Canvas`,
      );
    }
    const stagedPath = request.rendererArtifact.startsWith('upload/')
      ? stagedRendererPath(canvasId, request.rendererArtifact)
      : null;
    const rendererExists = request.rendererArtifact.startsWith('upload/')
      ? stagedPath !== null && existsSync(stagedPath)
      : Boolean(await space(canvasId).blobs.head(request.rendererArtifact));
    if (!rendererExists) {
      throw new InteractiveViewServiceError(
        'renderer_not_found',
        `Renderer artifact ${request.rendererArtifact} does not exist in this Canvas`,
      );
    }

    const definition = interactiveViewDefinitionV1Schema.parse({
      protocolVersion: 1,
      ownerThreadId: request.ownerThreadId,
      state: request.state,
      bindings: request.bindings,
      actions: request.actions,
    });
    validateDefinition(definition);

    const nodeId = createId('node') as CanvasNodeId;
    const output = await executeOnServer({
      canvasId,
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: nodeId,
              nodeType: 'web',
              position: request.position,
              ...(request.size ? { size: request.size } : {}),
              data: {
                label: request.label ?? 'Interactive View',
                labelSource: 'agent',
                src: request.rendererArtifact,
                interactiveView: definition,
                ...(request.viewKey ? { viewKey: request.viewKey } : {}),
              },
            },
          ],
        },
      ],
      originator: {
        source: 'agent',
        threadId: request.ownerThreadId,
      },
      computeChanges: true,
    });
    if (!output.results[0]?.applied) {
      throw new InteractiveViewServiceError(
        'view_create_failed',
        output.results[0]?.reason ?? 'Interactive View creation was rejected',
      );
    }
    return this.get(canvasId, nodeId);
  }

  async replaceState(
    canvasId: string,
    nodeId: string,
    revision: string,
    value: InteractiveViewJsonValue,
    actor: 'host-bridge' | 'trusted-agent',
  ): Promise<InteractiveViewResource> {
    const current = await this.get(canvasId, nodeId);
    if (
      actor === 'host-bridge' &&
      !current.definition.actions.some(
        (action) => action.kind === 'state.replace',
      )
    ) {
      throw new InteractiveViewServiceError(
        'action_not_granted',
        'State replacement is not granted to this View',
      );
    }
    const stateIssue = validateInteractiveViewState(
      current.definition.state.schema,
      value,
    );
    if (stateIssue) {
      throw new InteractiveViewServiceError('invalid_state', stateIssue);
    }
    const nextDefinition: InteractiveViewDefinitionV1 = {
      ...current.definition,
      state: {
        ...current.definition.state,
        value,
      },
    };
    validateDefinition(nextDefinition);

    const output = await executeOnServer({
      canvasId,
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: nodeId as CanvasNodeId,
              patch: { interactiveView: nextDefinition },
              expectViewRev: revision,
            },
          ],
        },
      ],
      originator: { source: 'ui' },
    });
    const conflict = output.viewConflicts?.[0];
    if (conflict) {
      throw new InteractiveViewServiceError(
        'view_conflict',
        'Interactive View changed since it was loaded',
        conflict,
      );
    }
    if (!output.results[0]?.applied) {
      throw new InteractiveViewServiceError(
        'view_update_failed',
        output.results[0]?.reason ?? 'Interactive View update was rejected',
      );
    }
    return this.get(canvasId, nodeId);
  }

  async submitAgentEvent(
    canvasId: string,
    nodeId: string,
    actionId: string,
    input: InteractiveViewJsonValue | undefined,
    logger: FastifyBaseLogger,
  ): Promise<void> {
    const inputIssue =
      input === undefined ? null : validateInteractiveViewJsonBounds(input);
    if (inputIssue) {
      throw new InteractiveViewServiceError('invalid_definition', inputIssue);
    }
    const resource = await this.get(canvasId, nodeId);
    const grant = resource.definition.actions.find(
      (candidate) => candidate.actionId === actionId,
    );
    if (!grant) {
      throw new InteractiveViewServiceError(
        'action_not_granted',
        `Action "${actionId}" is not granted to this View`,
      );
    }
    if (grant.kind !== 'agent.submit') {
      throw new InteractiveViewServiceError(
        'action_not_available',
        `Action "${actionId}" is not an Agent submission`,
      );
    }

    const event = {
      protocolVersion: 1 as const,
      nodeId,
      actionId,
      ...(input !== undefined ? { input } : {}),
      viewRevision: resource.revision,
    };
    const ownerTarget = await resolveOwnerThread(
      canvasId,
      resource.definition.ownerThreadId,
    );
    if (!ownerTarget) {
      throw new InteractiveViewServiceError(
        'invalid_owner_thread',
        `Owner thread ${resource.definition.ownerThreadId} is not an external Agent thread in this Canvas`,
      );
    }
    const envelope = {
      user: {
        text: `Interactive View action: ${actionId}`,
        attachments: [],
      },
      skills: { invokedIds: [], resolved: [] },
      focus: {
        selection: {
          refs: [],
          selectedIds: [],
          imageAttachments: [],
          snapshotAttachments: [],
        },
        anchor: { nodeId },
      },
    };
    let invocation;
    try {
      invocation = await agentThreadService.invokeSubmission({
        threadId: resource.definition.ownerThreadId,
        canvasId,
        content: envelope.user.text,
        mode: 'operate',
        envelope,
        submission: createInteractiveViewSubmission(event),
        requestBinding: ownerTarget.binding,
        fixedTarget: ownerTarget.fixedTarget,
        logger,
      });
    } catch (error) {
      if (error instanceof AgentThreadBusyError) {
        throw new InteractiveViewServiceError('thread_busy', error.message);
      }
      throw error;
    }
    void (async () => {
      try {
        for await (const _event of invocation.events) {
          // AgentThreadService and Agenetes persist the durable turn.
        }
      } catch (error) {
        logger.error(
          { err: error, canvasId, nodeId, actionId },
          'Interactive View Agent submission failed',
        );
      }
    })();
  }
}

export const interactiveViewService = new InteractiveViewService();
