// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  agentConversationOwnerQuerySchema,
  agentConversationOwnerResponseSchema,
  agentHistoryPageParamsSchema,
} from '@huabu/shared';

import {
  agentThreadResolver,
  AgentThreadResolutionError,
} from './agent-thread-resolver.js';
import { hydrateCanvasNodes } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { space } from '../storage/index.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspaceKey,
} from '../workspace.js';

import type {
  AgentConversationOwnerEvent,
  AgentConversationOwnerState,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';
import type { FastifyPluginAsync } from 'fastify';

async function readOwner(
  canvasId: string,
  threadId: string,
  workspaceKey?: string,
): Promise<AgentConversationOwnerState> {
  const lease = acquireWorkspaceOperationLease();
  try {
    if (workspaceKey !== undefined && lease.workspaceKey !== workspaceKey)
      throw new Error('The observed Workspace changed');
    return await withCanvasMutex(canvasId, async () => {
      const owner = await agentThreadResolver.resolveAgentNode(
        canvasId,
        threadId,
      );
      if (!owner)
        return {
          state: 'unavailable',
          status: 404,
          error: {
            message:
              'The Agent conversation no longer has an owner in this Space',
            code: 'conversation_owner_missing',
          },
        };
      const handle = space(canvasId);
      const canvas = await handle.read();
      const node = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
        (candidate) => candidate.id === owner.nodeId,
      );
      if (!node || node.type !== 'question' || node.data?.threadId !== threadId)
        return {
          state: 'unavailable',
          status: 409,
          error: {
            message: 'The Agent conversation owner changed',
            code: 'conversation_owner_mismatch',
          },
        };
      const record = await handle.nodes.read(owner.nodeId);
      if (!record)
        return {
          state: 'unavailable',
          status: 404,
          error: {
            message: 'The Agent node content is unavailable',
            code: 'missing_node_content',
          },
        };
      const hydrated = hydrateCanvasNodes(new Map([[node.id, record]]), [
        node,
      ])[0];
      return {
        state: 'ready',
        owner: agentConversationOwnerResponseSchema.parse({
          canvasId,
          nodeId: owner.nodeId,
          threadId,
          spaceTitle: canvas?.title ?? null,
          source: {
            ...hydrated.data,
            hasAuthoredContent:
              typeof hydrated.data.content === 'string' &&
              hydrated.data.content.trim().length > 0,
            agentBinding: owner.agentBinding,
            agentLaunchOverrides: owner.launchOverrides,
          },
        }),
      };
    });
  } catch (error) {
    if (error instanceof AgentThreadResolutionError)
      return {
        state: 'unavailable',
        status: error.code === 'canvas_not_found' ? 404 : 409,
        error: { message: error.message, code: error.code },
      };
    throw error;
  } finally {
    lease.release();
  }
}

const conversationOwnerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/owner/:threadId', async (request, reply) => {
    const params = agentHistoryPageParamsSchema.safeParse(request.params);
    const query = agentConversationOwnerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid conversation address' });
    const result = await readOwner(query.data.canvasId, params.data.threadId);
    reply.header('Cache-Control', 'no-store');
    return result.state === 'ready'
      ? reply.send(result.owner)
      : reply.code(result.status).send(result.error);
  });

  fastify.get('/owner/:threadId/stream', async (request, reply) => {
    const params = agentHistoryPageParamsSchema.safeParse(request.params);
    const query = agentConversationOwnerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid conversation address' });
    const { canvasId } = query.data;
    const { threadId } = params.data;
    const workspaceKey = getWorkspaceKey();
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    reply.raw.write(': ok\n\n');
    const streamId = randomUUID();
    let revision = 0;
    let closed = false;
    let reading = false;
    let dirty = false;
    let nodeId: string | undefined;
    let previous: string | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const write = (event: AgentConversationOwnerEvent) => {
      if (!closed)
        reply.raw.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
    };
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(readTimer);
      unsubscribe();
    };
    const fail = (error: unknown, status = 503) => {
      if (closed) return;
      request.log.error(
        { err: error, canvasId, threadId },
        'Conversation snapshot read failed',
      );
      write({
        type: 'error',
        data: {
          status,
          error: {
            message:
              status === 408
                ? 'The conversation status query timed out'
                : 'Unable to read the conversation state',
          },
        },
      });
      cleanup();
      reply.raw.end();
    };
    const refresh = () => {
      dirty = true;
      if (reading || closed) return;
      reading = true;
      void (async () => {
        try {
          while (dirty && !closed) {
            dirty = false;
            readTimer = setTimeout(
              () => fail(new Error('Owner query timed out'), 408),
              10_000,
            );
            const value = await readOwner(canvasId, threadId, workspaceKey);
            clearTimeout(readTimer);
            if (closed) return;
            nodeId = value.state === 'ready' ? value.owner.nodeId : undefined;
            // A write during the read invalidates it before publication.
            if (dirty) continue;
            const encoded = JSON.stringify(value);
            if (encoded === previous) continue;
            previous = encoded;
            write({
              type: 'snapshot',
              data: { streamId, revision: ++revision, value },
            });
          }
        } catch (error) {
          fail(error);
        } finally {
          reading = false;
        }
      })();
    };
    const unsubscribe = subscribeCanvasUpdates(canvasId, (event) => {
      if (!nodeId || event.type === 'snapshot') return refresh();
      if (event.type === 'invalidate') {
        if (!event.data.nodeIds || event.data.nodeIds.includes(nodeId))
          refresh();
      } else if (event.type === 'update') {
        const { pendingEffects } = event.data;
        if (
          event.data.threadId === threadId ||
          pendingEffects.deletedNodeIds.includes(nodeId) ||
          pendingEffects.contentEditedNodeIds.includes(nodeId) ||
          pendingEffects.mutatedNodes.some(
            (node) =>
              typeof node === 'object' &&
              node !== null &&
              'id' in node &&
              node.id === nodeId,
          )
        )
          refresh();
      }
    });
    reply.raw.once('close', cleanup);
    refresh();
  });
};

export default conversationOwnerRoutes;
