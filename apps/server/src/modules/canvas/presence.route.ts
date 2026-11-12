// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Space presence routes.
 *
 * `POST /:canvasId/presence` reports what this page is pointing at, selecting,
 * dragging or editing; `POST /:canvasId/presence/leave` withdraws it. Both
 * only need read access to the Space, the same as the Canvas Sync stream that
 * delivers presence to the other pages, and neither reads nor writes the
 * Space: presence lives in memory (see `canvas-presence.ts`).
 */

import {
  CANVAS_PRESENCE_LIMITS,
  canvasPresenceLeaveBodySchema,
  canvasPresenceReportBodySchema,
  recentCanvasConversationParamsSchema,
} from '@huabu/shared';

import { canvasPresence } from './canvas-presence.js';
import { getWorkspaceHandle } from '../workspace.js';

import type {
  CanvasPresenceLeaveBody,
  CanvasPresenceReportBody,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Presence of one Space never reaches a same-named Space of another Workspace. */
export function presenceSpaceKey(canvasId: string): string {
  return `${getWorkspaceHandle()?.workspaceId ?? ''}\u0000${canvasId}`;
}

/**
 * Pointer reports are frequent, so these routes count against their own
 * per-peer budget instead of the application-wide one.
 */
const routeConfig = {
  spaceAccess: 'read',
  rateLimit: {
    max: CANVAS_PRESENCE_LIMITS.maxReportsPerPeerPerMinute,
    timeWindow: 60_000,
  },
} as const;

/** Largest valid report is three full id lists; anything bigger is refused unread. */
const BODY_LIMIT_BYTES = 128 * 1024;

const presenceRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{
    Params: { canvasId: string };
    Body: CanvasPresenceReportBody;
  }>(
    '/:canvasId/presence',
    { config: routeConfig, bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      const params = recentCanvasConversationParamsSchema.safeParse(
        request.params,
      );
      if (!params.success)
        return reply.code(400).send({
          message: params.error.issues[0]?.message ?? 'Invalid canvas ID',
        });
      const body = canvasPresenceReportBodySchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({
          message: body.error.issues[0]?.message ?? 'Invalid presence report',
        });
      const result = canvasPresence.report(
        presenceSpaceKey(params.data.canvasId),
        body.data,
      );
      if (result === 'rate-limited')
        return reply
          .code(429)
          .header('Retry-After', '1')
          .send({
            message: 'Presence is reported too often',
            code: 'PRESENCE_RATE_LIMITED',
            details: { retryAfterSeconds: 1 },
          });
      if (result === 'full')
        return reply
          .code(429)
          .header('Retry-After', '30')
          .send({
            message: 'Too many pages have this Space open',
            code: 'PRESENCE_SPACE_FULL',
            details: { retryAfterSeconds: 30 },
          });
      return reply.code(204).send();
    },
  );

  fastify.post<{
    Params: { canvasId: string };
    Body: CanvasPresenceLeaveBody;
  }>(
    '/:canvasId/presence/leave',
    { config: routeConfig, bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      const params = recentCanvasConversationParamsSchema.safeParse(
        request.params,
      );
      if (!params.success)
        return reply.code(400).send({
          message: params.error.issues[0]?.message ?? 'Invalid canvas ID',
        });
      const body = canvasPresenceLeaveBodySchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({
          message: body.error.issues[0]?.message ?? 'Invalid page ID',
        });
      canvasPresence.leave(
        presenceSpaceKey(params.data.canvasId),
        body.data.pageId,
      );
      return reply.code(204).send();
    },
  );
};

export default presenceRoutes;
