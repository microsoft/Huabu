import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { type FastifyPluginAsync } from 'fastify';

import { getKnowledgeRepository } from './knowledge.repository.js';
import { listCanvases, type NodeLike } from '../canvas/canvas.filestore.js';
import { getArtifactsDir } from '../workspace.js';

/**
 * Collect all sourceIds referenced by any canvas node.
 */
function collectUsedSourceIds(): Set<string> {
  const used = new Set<string>();
  const canvases = listCanvases();
  for (const canvas of canvases) {
    const nodes = (canvas.state.nodes ?? []) as NodeLike[];
    for (const node of nodes) {
      const sid = node.data?.sourceId as string | undefined;
      if (sid) used.add(sid);
    }
  }
  return used;
}

/**
 * Delete artifact files referenced by the source's `src` field.
 * Only removes local artifacts (those matching /api/artifact/<filename>).
 */
function deleteSourceArtifacts(src: string | null): void {
  if (!src) return;
  const match = /\/api\/artifact\/([^/?#]+)/.exec(src);
  if (!match) return;
  const filename = path.basename(match[1]);
  const filePath = path.resolve(getArtifactsDir(), filename);
  // Guard against path traversal
  if (!filePath.startsWith(path.resolve(getArtifactsDir()))) return;
  if (existsSync(filePath)) unlinkSync(filePath);
}

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

  // Delete a source by ID (also removes associated artifact files)
  fastify.delete('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);

    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    // Delete associated artifact files first
    deleteSourceArtifacts(source.src);

    // Delete the source file
    repo.deleteSource(id);

    return { success: true };
  });

  // Delete all sources not referenced by any canvas
  fastify.delete('/knowledge/sources/unused', async (_request, _reply) => {
    const repo = await getKnowledgeRepository();
    const usedIds = collectUsedSourceIds();
    const allSources = repo.findAllSources();

    let deleted = 0;
    for (const source of allSources) {
      if (!usedIds.has(source.sourceId)) {
        deleteSourceArtifacts(source.src);
        repo.deleteSource(source.sourceId);
        deleted++;
      }
    }

    return { deleted };
  });
};

export default knowledgeRoute;
