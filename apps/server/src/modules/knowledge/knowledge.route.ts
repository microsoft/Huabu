import { access, unlink } from 'node:fs/promises';
import path from 'node:path';

import { type FastifyPluginAsync } from 'fastify';

import { getKnowledgeRepository } from './knowledge.repository.js';
import {
  listCanvases,
  readCanvas,
  writeCanvas,
  type NodeLike,
} from '../canvas/canvas.filestore.js';
import { getArtifactsDir } from '../workspace.js';

/**
 * Collect all sourceIds referenced by any canvas node,
 * and map each sourceId to the set of canvasIds that reference it.
 */
function collectSourceCanvasMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const canvases = listCanvases();
  for (const canvas of canvases) {
    const nodes = (canvas.state.nodes ?? []) as NodeLike[];
    for (const node of nodes) {
      const sid = node.data?.sourceId as string | undefined;
      if (sid) {
        let set = map.get(sid);
        if (!set) {
          set = new Set();
          map.set(sid, set);
        }
        set.add(canvas.canvasId);
      }
    }
  }
  return map;
}

/**
 * Delete artifact files referenced by the source's `src` field.
 * Only removes local artifacts (those matching /api/artifact/<filename>).
 */
async function deleteSourceArtifacts(src: string | null): Promise<void> {
  if (!src) return;
  const match = /\/api\/artifact\/([^/?#]+)/.exec(src);
  if (!match) return;
  const filename = path.basename(match[1]);
  const filePath = path.resolve(getArtifactsDir(), filename);
  // Guard against path traversal
  if (!filePath.startsWith(path.resolve(getArtifactsDir()))) return;
  try {
    await access(filePath);
    await unlink(filePath);
  } catch {
    // File doesn't exist or can't be removed — ignore
  }
}

/**
 * Remove all nodes that reference a given sourceId from the specified canvases and persist.
 */
function removeSourceFromCanvases(
  sourceId: string,
  canvasIds: Set<string>,
): void {
  for (const canvasId of canvasIds) {
    const canvas = readCanvas(canvasId);
    if (!canvas) continue;
    const nodes = (canvas.state.nodes ?? []) as NodeLike[];
    const nodeIdsToRemove = new Set(
      nodes
        .filter((n) => (n.data?.sourceId as string | undefined) === sourceId)
        .map((n) => n.id as string)
        .filter(Boolean),
    );
    if (nodeIdsToRemove.size === 0) continue;
    canvas.state.nodes = nodes.filter(
      (n) => !nodeIdsToRemove.has(n.id as string),
    );
    // Also remove edges that reference removed nodes
    const edges = (canvas.state.edges ?? []) as Array<Record<string, unknown>>;
    canvas.state.edges = edges.filter(
      (e) =>
        !nodeIdsToRemove.has(e.source as string) &&
        !nodeIdsToRemove.has(e.target as string),
    );
    canvas.version += 1;
    canvas.updatedAt = Date.now();
    writeCanvas(canvas);
  }
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

  // Check which canvases reference a source (read-only pre-flight check)
  fastify.get('/knowledge/source/:id/usage', async (request, reply) => {
    const { id } = request.params as { id: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);
    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    const sourceCanvasMap = collectSourceCanvasMap();
    const canvasIds = sourceCanvasMap.get(id);
    if (!canvasIds || canvasIds.size === 0) {
      return { referencedBy: [] };
    }

    const canvases = listCanvases();
    const refs = canvases
      .filter((c) => canvasIds.has(c.canvasId))
      .map((c) => ({ canvasId: c.canvasId, title: c.title }));
    return { referencedBy: refs };
  });

  // Delete a source by ID (also removes associated artifact files and canvas references)
  fastify.delete('/knowledge/source/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { force } = request.query as { force?: string };

    const repo = await getKnowledgeRepository();
    const source = repo.findSourceById(id);

    if (!source) {
      return reply.code(404).send({ error: 'Source not found' });
    }

    // Check which canvases reference this source
    const sourceCanvasMap = collectSourceCanvasMap();
    const referencingCanvasIds = sourceCanvasMap.get(id);

    // If referenced and not forced, return canvas usage info so frontend can warn
    if (
      referencingCanvasIds &&
      referencingCanvasIds.size > 0 &&
      force !== '1'
    ) {
      const canvases = listCanvases();
      const refs = canvases
        .filter((c) => referencingCanvasIds.has(c.canvasId))
        .map((c) => ({ canvasId: c.canvasId, title: c.title }));
      return reply.code(409).send({
        error: 'Source is referenced by canvases',
        referencedBy: refs,
      });
    }

    // Remove nodes referencing this source from all canvases
    if (referencingCanvasIds && referencingCanvasIds.size > 0) {
      removeSourceFromCanvases(id, referencingCanvasIds);
    }

    // Delete associated artifact files first
    await deleteSourceArtifacts(source.src);

    // Delete the source record
    await repo.deleteSource(id);

    return { success: true };
  });

  // Delete all sources not referenced by any canvas
  fastify.delete('/knowledge/sources/unused', async (_request, _reply) => {
    const repo = await getKnowledgeRepository();
    const sourceCanvasMap = collectSourceCanvasMap();
    const allSources = repo.findAllSources();

    // Collect targets first, then delete — so a mid-loop failure doesn't leave partial state unreported
    const targets = allSources.filter((s) => !sourceCanvasMap.has(s.sourceId));

    let deleted = 0;
    const failed: string[] = [];
    for (const source of targets) {
      try {
        await deleteSourceArtifacts(source.src);
        await repo.deleteSource(source.sourceId);
        deleted++;
      } catch {
        failed.push(source.sourceId);
      }
    }

    return { deleted, failed: failed.length > 0 ? failed : undefined };
  });
};

export default knowledgeRoute;
