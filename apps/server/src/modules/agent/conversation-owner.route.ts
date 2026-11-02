// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  agentConversationOwnerQuerySchema,
  agentConversationOwnerResponseSchema,
  agentHistoryPageParamsSchema,
} from '@huabu/shared';

import {
  AgentThreadResolver,
  AgentThreadResolutionError,
} from './agent-thread-resolver.js';
import { hydrateCanvasNodes } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { space } from '../storage/index.js';
import { currentWorkspaceScope, runInWorkspace } from '../workspace/context.js';
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

const observationEpoch = randomUUID();
let observationRevision = 0;
const pendingStorageReads = new Map<string, Promise<unknown>>();

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

function readStorage<T>(
  key: string,
  read: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  // Drivers may not cancel I/O. Never queue another read behind abandoned I/O.
  if (pendingStorageReads.has(key))
    throw new Error('A previous conversation storage read is still pending');
  const operation = read();
  pendingStorageReads.set(key, operation);
  void operation.then(
    () => pendingStorageReads.delete(key),
    () => pendingStorageReads.delete(key),
  );
  return abortable(operation, signal);
}

async function readOwner(
  canvasId: string,
  threadId: string,
  workspaceKey: string,
  signal: AbortSignal,
): Promise<AgentConversationOwnerState> {
  return abortable(
    withCanvasMutex(canvasId, async () => {
      signal.throwIfAborted();
      const lease = acquireWorkspaceOperationLease();
      try {
        if (lease.workspaceKey !== workspaceKey)
          throw new Error('The observed Workspace changed');
        // Capture the handle once: abandoned reads cannot follow a Workspace switch.
        const handle = space(canvasId);
        const readKey = JSON.stringify([workspaceKey, canvasId]);
        const canvas = await readStorage(readKey, () => handle.read(), signal);
        const resolver = new AgentThreadResolver({
          readCanvasNodes: async () =>
            canvas ? (canvas.state.nodes as CanvasNode[]) : null,
          readNodeContent: async (id, nodeId) =>
            (
              await readStorage(
                JSON.stringify([workspaceKey, id, nodeId]),
                () => handle.nodes.read(nodeId),
                signal,
              )
            )?.record.content ?? null,
        });
        const readState = async (): Promise<AgentConversationOwnerState> => {
          const owner = await resolver.resolveAgentNode(canvasId, threadId);
          signal.throwIfAborted();
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
          const node = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
            (candidate) => candidate.id === owner.nodeId,
          );
          if (
            !node ||
            node.type !== 'question' ||
            node.data?.threadId !== threadId
          )
            return {
              state: 'unavailable',
              status: 409,
              error: {
                message: 'The Agent conversation owner changed',
                code: 'conversation_owner_mismatch',
              },
            };
          const record = await readStorage(
            JSON.stringify([workspaceKey, canvasId, owner.nodeId]),
            () => handle.nodes.read(owner.nodeId),
            signal,
          );
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
        };
        let value: AgentConversationOwnerState;
        try {
          value = await readState();
        } catch (error) {
          if (!(error instanceof AgentThreadResolutionError)) throw error;
          value = {
            state: 'unavailable',
            status: error.code === 'canvas_not_found' ? 404 : 409,
            error: { message: error.message, code: error.code },
          };
        }
        signal.throwIfAborted();
        const observation = {
          epoch: observationEpoch,
          revision: ++observationRevision,
        };
        return value.state === 'ready'
          ? { ...value, owner: { ...value.owner, observation } }
          : { ...value, error: { ...value.error, details: { observation } } };
      } finally {
        lease.release();
      }
    }),
    signal,
  );
}

const conversationOwnerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/owner/:threadId', async (request, reply) => {
    const params = agentHistoryPageParamsSchema.safeParse(request.params);
    const query = agentConversationOwnerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid conversation address' });
    const controller = new AbortController();
    const close = () => controller.abort();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Owner query timed out', 'TimeoutError'),
        ),
      10_000,
    );
    reply.raw.once('close', close);
    try {
      const result = await readOwner(
        query.data.canvasId,
        params.data.threadId,
        getWorkspaceKey(),
        controller.signal,
      );
      reply.header('Cache-Control', 'no-store');
      return result.state === 'ready'
        ? reply.send(result.owner)
        : reply.code(result.status).send(result.error);
    } catch (error) {
      if (controller.signal.aborted && reply.raw.destroyed) return reply;
      request.log.error({ err: error }, 'Conversation owner read failed');
      return reply.code(controller.signal.aborted ? 408 : 503).send({
        message: controller.signal.aborted
          ? 'The conversation status query timed out'
          : 'Unable to read the conversation state',
      });
    } finally {
      clearTimeout(timer);
      reply.raw.off('close', close);
    }
  });

  fastify.get('/owner/:threadId/stream', async (request, reply) => {
    const params = agentHistoryPageParamsSchema.safeParse(request.params);
    const query = agentConversationOwnerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid conversation address' });
    const { canvasId } = query.data;
    const { threadId } = params.data;
    const workspaceKey = getWorkspaceKey();
    const workspaceScope = currentWorkspaceScope();
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
    const controller = new AbortController();
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
      controller.abort();
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
            // Publisher callbacks run in the writer's context. Restore the
            // observing request's Workspace for every authoritative read.
            const read = () =>
              readOwner(canvasId, threadId, workspaceKey, controller.signal);
            const value = await (workspaceScope
              ? runInWorkspace(workspaceScope, read)
              : read());
            clearTimeout(readTimer);
            if (closed) return;
            nodeId = value.state === 'ready' ? value.owner.nodeId : undefined;
            // A write during the read invalidates it before publication.
            if (dirty) continue;
            const encoded = JSON.stringify(
              value.state === 'ready'
                ? { ...value.owner, observation: undefined }
                : { ...value.error, details: undefined, status: value.status },
            );
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
