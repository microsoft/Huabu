import path from 'node:path';

import { createId } from '@sediment/shared';
import { type FastifyPluginAsync } from 'fastify';

import { artifactApiPath } from './utils.js';
import { getCanvasStore } from '../storage/index.js';

import type { ApiResult, ArtifactUploadResponse } from '@sediment/shared';

/**
 * Canvas-scoped artifact route. Mount under `/api/canvas`.
 *
 *   POST /:canvasId/artifact/:type   → upload (image | pdf | video)
 *   GET  /:canvasId/artifact/:filename → serve
 */
const artifactRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { canvasId: string; type: string };
    Reply: ApiResult<ArtifactUploadResponse>;
  }>('/:canvasId/artifact/:type', async (request, reply) => {
    const { canvasId, type } = request.params;

    const typeExtMap: Record<string, string> = {
      image: '.png',
      pdf: '.pdf',
      video: '.mp4',
    };

    if (!typeExtMap[type]) {
      return reply
        .code(400)
        .send({ message: 'Invalid type. Must be image, pdf, or video' });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ message: 'No file provided' });
    }

    const store = getCanvasStore(canvasId);
    const id = createId('artifact');
    const uploadedExt = path.extname(data.filename ?? '');
    const ext = uploadedExt || typeExtMap[type];
    const filename = `${id}${ext}`;

    try {
      await store.writeArtifactStream(filename, data.file);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to stream artifact to disk');
      return reply.code(500).send({ message: 'Failed to save file' });
    }

    const response: ArtifactUploadResponse = {
      id,
      uri: artifactApiPath(canvasId, filename),
      filename: data.filename,
      mimetype: data.mimetype,
    };
    return reply.send(response);
  });

  fastify.get<{ Params: { canvasId: string; filename: string } }>(
    '/:canvasId/artifact/:filename',
    async (request, reply) => {
      const { canvasId, filename } = request.params;
      const store = getCanvasStore(canvasId);

      try {
        return reply.sendFile(filename, store.artifactsDir());
      } catch {
        return reply.code(404).send({ message: 'Artifact not found' });
      }
    },
  );
};

export default artifactRoute;
