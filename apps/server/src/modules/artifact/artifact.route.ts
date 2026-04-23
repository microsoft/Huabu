import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { createId } from '@sediment/shared';
import { type FastifyPluginAsync } from 'fastify';

import { ARTIFACT_API_PREFIX, getArtifactsDir } from './utils.js';

const artifactRoute: FastifyPluginAsync = async (fastify) => {
  // Upload artifact with type parameter
  fastify.post('/artifact/:type', async (request, reply) => {
    const { type } = request.params as { type: string };

    // Validate type and set default extension
    const typeExtMap: Record<string, string> = {
      image: '.png',
      pdf: '.pdf',
      video: '.mp4',
    };

    if (!typeExtMap[type]) {
      return reply
        .code(400)
        .send({ error: 'Invalid type. Must be image, pdf, or video' });
    }

    const data = await request.file();

    if (!data) {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const artifactsDir = getArtifactsDir();

    const id = createId('artifact');
    const uploadedExt = path.extname(data.filename ?? '');
    const ext = uploadedExt || typeExtMap[type];
    const filename = `${id}${ext}`;
    const filePath = path.join(artifactsDir, filename);

    try {
      await pipeline(data.file, createWriteStream(filePath));
    } catch (error) {
      request.log.error({ err: error }, 'Failed to stream artifact to disk');
      return reply.code(500).send({ error: 'Failed to save file' });
    }

    return {
      id,
      uri: `${ARTIFACT_API_PREFIX}/${filename}`,
      filename: data.filename,
      mimetype: data.mimetype,
    };
  });

  // Serve artifact by ID
  fastify.get('/artifact/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifactsDir = getArtifactsDir();

    try {
      return reply.sendFile(id, artifactsDir);
    } catch {
      return reply.code(404).send({ error: 'Artifact not found' });
    }
  });
};

export default artifactRoute;
