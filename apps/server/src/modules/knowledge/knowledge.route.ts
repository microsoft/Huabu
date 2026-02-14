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

    return sources.map((s) => ({
      sourceId: s.source_id,
      workspaceId: s.workspace_id,
      type: s.type,
      title: s.title,
      src: s.uri,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      content: s.content_text,
      contentHash: s.content_hash,
      metaJson: s.meta_json,
    }));
  });

  // Get source content by ID
  fastify.get('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);

    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    return {
      sourceId: source.source_id,
      workspaceId: source.workspace_id,
      type: source.type,
      title: source.title,
      src: source.uri,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      content: source.content_text,
      contentHash: source.content_hash,
      metaJson: source.meta_json,
    };
  });
};

export default knowledgeRoute;
