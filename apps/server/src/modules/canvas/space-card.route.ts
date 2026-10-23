// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { acpSessionRegistry } from '@agenetes/acp-driver';

import {
  recentCanvasConversationParamsSchema,
  renameSpaceBodySchema,
  spaceCardAgentSchema,
  spaceCardQuerySchema,
} from '@huabu/shared';

import { publishCanvasUpdate } from './canvas-sync.js';
import { withCanvasMutex } from './write-coordinator.js';
import { agentThreadService } from '../agent/agent-thread.service.js';
import { getStructuredStore, space } from '../storage/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { acquireWorkspaceOperationLease } from '../workspace.js';

import type { SpaceAgentActivity, SpaceCardSnapshot } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

export function summarizeSpaceAgents(
  nodes: readonly unknown[],
  isActive: (threadId: string) => boolean,
  needsApproval: (threadId: string) => boolean,
): SpaceAgentActivity {
  const agents: SpaceAgentActivity = [];
  const seen = new Set<string>();
  for (const raw of nodes) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      raw.type !== 'question'
    )
      continue;
    if (!('data' in raw) || !raw.data || typeof raw.data !== 'object') continue;
    const data = raw.data;
    if (
      !('threadId' in data) ||
      typeof data.threadId !== 'string' ||
      !data.threadId ||
      seen.has(data.threadId)
    )
      continue;
    seen.add(data.threadId);
    let status: SpaceAgentActivity[number]['status'] = 'idle';
    if (isActive(data.threadId)) {
      status = needsApproval(data.threadId) ? 'approval' : 'running';
    } else if ('status' in data) {
      if (data.status === 'running') status = 'unknown';
      else if ('viewed' in data && data.viewed === false) {
        if (data.status === 'error') status = 'error';
        else if (data.status === 'done') status = 'unread';
      }
    }
    const parsed = spaceCardAgentSchema.safeParse({
      ...data,
      nodeId: 'id' in raw ? raw.id : undefined,
      title: null,
      status,
    });
    if (!parsed.success) throw new Error('Invalid Space Agent identity');
    agents.push(parsed.data);
  }
  return agents;
}

export function registerSpaceCardRoutes(app: FastifyInstance): void {
  app.post('/cards/query', async (request, reply) => {
    const parsed = spaceCardQuerySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: 'Invalid Space card query' });
    reply.header('Cache-Control', 'no-store');
    const lease = acquireWorkspaceOperationLease();
    try {
      const entries = await Promise.all(
        [...new Set(parsed.data.canvasIds)].map(
          async (canvasId): Promise<[string, SpaceCardSnapshot]> => {
            try {
              const handle = space(canvasId);
              const record = await handle.read();
              if (!record) return [canvasId, { status: 'missing' }];
              const namespace = canvasAcpNamespace(canvasId);
              const activity = summarizeSpaceAgents(
                record.state.nodes,
                (threadId) => agentThreadService.isActive(threadId, canvasId),
                (threadId) =>
                  acpSessionRegistry.hasPendingPermissions(
                    threadId,
                    namespace.name,
                  ),
              );
              const labels = await handle.nodes.readMany(
                activity.map((agent) => agent.nodeId),
              );
              for (const agent of activity) {
                agent.title = labels.get(agent.nodeId)?.record.label ?? null;
              }
              return [
                canvasId,
                {
                  status: 'ready',
                  title: record.title,
                  updatedAt: record.updatedAt,
                  activity,
                },
              ];
            } catch (error) {
              request.log.error(
                { err: error, canvasId },
                'Space activity read failed',
              );
              return [canvasId, { status: 'error' }];
            }
          },
        ),
      );
      return reply.send({ spaces: Object.fromEntries(entries) });
    } finally {
      lease.release();
    }
  });

  app.patch('/:canvasId/title', async (request, reply) => {
    const params = recentCanvasConversationParamsSchema.safeParse(
      request.params,
    );
    const body = renameSpaceBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ message: 'Invalid Space rename' });
    const { canvasId } = params.data;
    const lease = acquireWorkspaceOperationLease();
    try {
      return await withCanvasMutex(canvasId, async () => {
        const handle = space(canvasId);
        const current = await handle.read();
        if (!current)
          return reply.code(404).send({ message: 'Space not found' });
        if (current.title !== body.data.expectedTitle)
          return reply.code(409).send({
            code: 'SPACE_TITLE_CHANGED',
            message: 'The Space name changed. Refresh and try again.',
          });
        const renamed = await getStructuredStore()
          .spaces()
          .rename({ canvasId, title: body.data.title });
        if (!renamed.ok)
          return reply
            .code(
              renamed.reason === 'not-found'
                ? 404
                : renamed.reason === 'world-forbidden'
                  ? 403
                  : 409,
            )
            .send({
              code:
                renamed.reason === 'title-conflict'
                  ? 'CANVAS_TITLE_CONFLICT'
                  : 'SPACE_RENAME_REJECTED',
              message: 'Unable to rename this Space',
            });
        const record = {
          ...renamed.record,
          version: current.version + 1,
          updatedAt: Date.now(),
        };
        const written = await handle.write({
          expectedVersion: current.version,
          nextRecord: record,
          nodeMutations: [],
        });
        if (!written.ok)
          throw new Error(
            `Space rename metadata write failed: ${written.reason}`,
          );
        publishCanvasUpdate(canvasId, {
          type: 'snapshot',
          data: { version: record.version },
        });
        return reply.send({ title: record.title, updatedAt: record.updatedAt });
      });
    } catch (error) {
      request.log.error({ err: error, canvasId }, 'Space rename failed');
      return reply.code(500).send({
        code: 'SPACE_RENAME_FAILED',
        message: 'Unable to confirm the Space rename. Refresh before retrying.',
      });
    } finally {
      lease.release();
    }
  });
}
