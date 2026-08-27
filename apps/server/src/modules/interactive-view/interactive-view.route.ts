// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import {
  interactiveViewActionRequestSchema,
  interactiveViewResourceParamsSchema,
  replaceInteractiveViewStateRequestSchema,
  type ApiResult,
  type InteractiveViewActionRequest,
  type InteractiveViewActionResponse,
  type InteractiveViewResource,
  type InteractiveViewRuntimeSnapshot,
  type ReplaceInteractiveViewStateRequest,
} from '@huabu/shared';

import {
  InteractiveViewServiceError,
  interactiveViewService,
} from './interactive-view.service.js';
import { sendBlob } from '../artifact/send-blob.js';
import { space } from '../storage/index.js';

import type { FastifyPluginAsync } from 'fastify';

function statusFor(error: InteractiveViewServiceError): number {
  switch (error.code) {
    case 'canvas_not_found':
    case 'view_not_found':
      return 404;
    case 'view_conflict':
    case 'thread_busy':
      return 409;
    case 'invalid_definition':
    case 'invalid_state':
    case 'invalid_owner_thread':
    case 'renderer_not_found':
    case 'action_not_granted':
    case 'action_not_available':
      return 400;
    default:
      return 500;
  }
}

const interactiveViewRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Params: { canvasId: string; nodeId: string };
  }>('/:canvasId/:nodeId/renderer', async (request, reply) => {
    const params = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    if (!params.success) {
      return reply.code(400).send({
        message: 'Invalid Interactive View renderer identity',
        code: 'validation_failed',
      });
    }
    try {
      const blobs = space(params.data.canvasId).blobs;
      const resource = await interactiveViewService.get(
        params.data.canvasId,
        params.data.nodeId,
      );
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          'img-src data: blob:',
          'font-src data:',
          'media-src data: blob:',
          "connect-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-src 'none'",
          "worker-src 'none'",
          "navigate-to 'none'",
          "frame-ancestors 'self'",
        ].join('; '),
      );
      const sent = await sendBlob(
        request,
        reply,
        blobs,
        resource.rendererArtifact,
      );
      if (!sent) {
        return reply.code(404).send({
          message: 'Interactive View renderer artifact does not exist',
          code: 'renderer_not_found',
        });
      }
      return reply;
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post<{
    Params: { canvasId: string; nodeId: string; actionId: string };
    Body: InteractiveViewActionRequest;
    Reply: ApiResult<InteractiveViewActionResponse>;
  }>('/:canvasId/:nodeId/actions/:actionId', async (request, reply) => {
    const params = interactiveViewActionParamsSchema.safeParse(request.params);
    const body = interactiveViewActionRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!params.success || !body.success) {
      return reply.code(400).send({
        message: 'Invalid Interactive View action request',
        code: 'validation_failed',
      });
    }
    try {
      await interactiveViewService.submitAgentEvent(
        params.data.canvasId,
        params.data.nodeId,
        params.data.actionId,
        body.data.input,
        request.log,
      );
      return reply.send({ accepted: true });
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get<{
    Params: { canvasId: string; nodeId: string };
    Reply: ApiResult<InteractiveViewResource>;
  }>('/:canvasId/:nodeId', async (request, reply) => {
    const parsed = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid View identity',
        code: 'validation_failed',
      });
    }
    try {
      return reply.send(
        await interactiveViewService.get(
          parsed.data.canvasId,
          parsed.data.nodeId,
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.put<{
    Params: { canvasId: string; nodeId: string };
    Body: ReplaceInteractiveViewStateRequest;
    Reply: ApiResult<InteractiveViewResource>;
  }>('/:canvasId/:nodeId/state', async (request, reply) => {
    const params = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    const body = replaceInteractiveViewStateRequestSchema.safeParse(
      request.body,
    );
    if (!params.success || !body.success) {
      return reply.code(400).send({
        message:
          (!params.success
            ? params.error.issues[0]?.message
            : body.success
              ? undefined
              : body.error.issues[0]?.message) ?? 'Invalid state replacement',
        code: 'validation_failed',
      });
    }
    try {
      return reply.send(
        await interactiveViewService.replaceState(
          params.data.canvasId,
          params.data.nodeId,
          body.data.revision,
          body.data.value,
          'host-bridge',
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply.code(statusFor(error)).send({
          message: error.message,
          code: error.code,
          ...(error.conflict
            ? {
                details: {
                  currentRevision: error.conflict.currentRevision,
                  currentState: error.conflict.currentState,
                },
              }
            : {}),
        });
      }
      throw error;
    }
  });

  app.get<{
    Params: { canvasId: string; nodeId: string };
    Reply: ApiResult<InteractiveViewRuntimeSnapshot>;
  }>('/:canvasId/:nodeId/runtime', async (request, reply) => {
    const parsed = interactiveViewResourceParamsSchema.safeParse(
      request.params,
    );
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid View identity',
        code: 'validation_failed',
      });
    }
    try {
      return reply.send(
        await interactiveViewService.runtimeSnapshot(
          parsed.data.canvasId,
          parsed.data.nodeId,
        ),
      );
    } catch (error) {
      if (error instanceof InteractiveViewServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });
};

const interactiveViewActionParamsSchema =
  interactiveViewResourceParamsSchema.extend({
    actionId: z.string().min(1).max(128),
  });

export default interactiveViewRoutes;
