import { type FastifyPluginAsync } from 'fastify';

import { getKnowledgeRepository } from './knowledge.repository.js';

const knowledgeRoute: FastifyPluginAsync = async (fastify) => {
  // Get all sources
  fastify.get('/knowledge/sources', async (_request, _reply) => {
    const repo = await getKnowledgeRepository();
    // Returns SourceOverview[] - no mapping needed
    return repo.findAllSourcesOverview();
  });

  // Get source content by ID
  fastify.get('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);

    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    // Return source directly - no mapping needed
    return source;
  });

  // Update source metadata (e.g., title)
  fastify.patch('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title } = request.body as { title?: string };

    const repo = await getKnowledgeRepository();
    const existingSource = repo.findSourceById(id);

    if (!existingSource) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    const updates: { title?: string } = {};
    if (title !== undefined) {
      updates.title = title;
    }

    const updatedSource = repo.updateSource(id, updates);
    return updatedSource;
  });
};

export default knowledgeRoute;
