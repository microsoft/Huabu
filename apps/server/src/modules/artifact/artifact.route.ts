import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@sediment/shared';
import { type FastifyPluginAsync } from 'fastify';

import { getArtifactsDir } from './utils.js';

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

    const buffer = await data.toBuffer();
    const artifactsDir = getArtifactsDir();

    const id = createId('artifact');
    const ext = path.extname(data.filename || typeExtMap[type]);
    const filename = `${id}${ext}`;
    const filePath = path.join(artifactsDir, filename);

    await writeFile(filePath, new Uint8Array(buffer));

    return {
      id,
      uri: `/api/artifact/${filename}`,
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
