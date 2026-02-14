import { type FastifyPluginAsync } from 'fastify';

import { getKnowledgeRepository } from './knowledge.repository.js';

const knowledgeRoute: FastifyPluginAsync = async (fastify) => {
  // Get all sources for a workspace
  fastify.get('/knowledge/sources', async (request, reply) => {
    const { workspaceId } = request.query as { workspaceId: string };

    if (!workspaceId) {
      return reply.code(400).send({ error: 'workspaceId is required' });
    }

    const repo = await getKnowledgeRepository();
    const sources = repo.findAllSources(workspaceId);

    return sources;
  });

  // Get source content by ID
  fastify.get('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);

    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    return source;
  });
};

export default knowledgeRoute;
